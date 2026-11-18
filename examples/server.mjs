// Console server (node:http, no framework). The keys stay here (decision D7): the browser only ever sees
// getState(), action results and the template report, which hold addresses, hashes and topic texts, never keys.
//
//   GET  /api/state      -> getState(ctx)
//   POST /api/actions    -> body {action, actor, params} -> runAction (the shared action library)
//   GET  /api/templates  -> the template files the next start would deploy, checked (guided story step 7)
//   GET  /*              -> static files from examples/public/ (the console page)
//
// Status codes: 200 for state, templates and for any action that was executed or refused on chain
// ({ok:false, reasons}); 400 for malformed JSON, a bad shape, an unknown action or bad input; 404 for an unknown
// /api/ path or file; 405 for the wrong method; 413 for a body over 64 KiB; 415 for a POST that is not
// application/json (this also stops a plain cross-site form from triggering an action); 503 when no deployment is
// loaded; 500 when the chain cannot be reached.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getState, runAction } from '../core/actions/index.mjs';
import { ROOT } from '../core/lib/paths.mjs';
import { listTemplateFiles, validateTemplate, loadTemplates, ConfigError, DEFAULT_TEMPLATE_DIR } from './lib/config.mjs';

export const PUBLIC_DIR = path.join(ROOT, 'examples', 'public');

export const MAX_BODY = 64 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': JSON_TYPE,
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Sent with every response. The page loads nothing from outside this server (no CDN) and cannot be framed. */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const BASE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': CONTENT_SECURITY_POLICY,
});

class HttpError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

function send(res, status, body, type = JSON_TYPE, extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': type, ...extra });
  res.end(data);
}

function methodNotAllowed(res, allow) {
  return send(res, 405, { ok: false, error: 'MethodNotAllowed', message: `use ${allow}` }, JSON_TYPE, { allow });
}

/** Reads the body up to `limit` bytes. Over the limit it stops collecting and rejects with a 413. */
function readBody(req, limit = MAX_BODY) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, 'PayloadTooLarge', `request body over ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return; // discard the rest of an oversized body
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, 'PayloadTooLarge', `request body over ${limit} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

async function serveStatic(res, publicDir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return send(res, 400, { ok: false, error: 'BadRequest', message: 'bad path' });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // No NUL bytes, no dot segments ("..", ".env"): nothing outside publicDir and no hidden files.
  if (rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return send(res, 404, { ok: false, error: 'NotFound' });
  const root = path.resolve(publicDir);
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(root + path.sep)) return send(res, 404, { ok: false, error: 'NotFound' });
  try {
    const s = await stat(file);
    if (!s.isFile()) return send(res, 404, { ok: false, error: 'NotFound' });
    return send(res, 200, await readFile(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    if (rel === '/index.html') {
      return send(
        res,
        200,
        'EEA Tokenization Starter Kit: the console page is not built yet. The API is at /api/state and /api/actions.\n',
        'text/plain; charset=utf-8',
      );
    }
    return send(res, 404, { ok: false, error: 'NotFound' });
  }
}

/** A path the browser may see: relative to the repository, or just the file name. Never a home directory. */
function shownPath(p) {
  const r = path.relative(ROOT, path.resolve(ROOT, String(p)));
  if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
  return path.basename(String(p));
}

/**
 * Guided story step 7 (C2): which template files the next start would deploy, each checked as the deployer
 * checks it (C1), and which of them are already deployed. Reads only the directories in the deployment record
 * (or templates/), never a path from the request.
 * @returns {{ok: boolean, network: string, dirs: string[], files: object[], error: object|null,
 *   pending: string[], missing: string[], restart: string}}
 */
export function templatesReport(ctx) {
  const d = ctx.deployment;
  const dirs = (d?.templateDirs?.length ? d.templateDirs : [DEFAULT_TEMPLATE_DIR]).map((x) => path.resolve(ROOT, String(x)));
  const deployed = d?.tokens ?? [];
  const restart = ctx.network === 'sepolia' ? 'NETWORK=sepolia REDEPLOY=1 npm start' : 'npm start';
  const problem = (e, file) =>
    e instanceof ConfigError
      ? { file: shownPath(e.file), field: e.field, problem: e.problem }
      : { file: shownPath(file), field: '(file)', problem: e instanceof SyntaxError ? `not valid JSON (${e.message})` : e.message };

  let files;
  try {
    files = listTemplateFiles(dirs);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { ok: false, network: ctx.network, dirs: dirs.map(shownPath), files: [], error: problem(e), pending: [], missing: [], restart };
  }
  const rows = files.map((file) => {
    try {
      const t = validateTemplate(JSON.parse(readFileSync(file, 'utf8')), file, ctx.kit);
      const token = deployed.find((x) => x.id === t.id);
      return {
        file: shownPath(file),
        valid: true,
        id: t.id,
        symbol: t.symbol,
        name: t.name,
        requiredTopics: t.requiredTopics,
        deployed: Boolean(token),
        token: token?.symbol ?? null,
        problem: null,
      };
    } catch (e) {
      const p = problem(e, file);
      return { file: shownPath(file), valid: false, id: null, symbol: null, name: null, requiredTopics: [], deployed: false, token: null, problem: { field: p.field, problem: p.problem } };
    }
  });
  // Cross-file rules (duplicate id or symbol, empty folder) exactly as npm start applies them.
  let error = null;
  try {
    loadTemplates(dirs, ctx.kit);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    error = problem(e);
  }
  const validIds = new Set(rows.filter((r) => r.valid).map((r) => r.id));
  return {
    ok: !error && rows.every((r) => r.valid),
    network: ctx.network,
    dirs: dirs.map(shownPath),
    files: rows,
    error,
    pending: rows.filter((r) => r.valid && !r.deployed).map((r) => r.symbol),
    missing: deployed.filter((t) => !validIds.has(t.id)).map((t) => t.symbol),
    restart,
  };
}

/** Builds the request handler. Exported so another module can mount it or extend it. */
export function createHandler({ ctx, publicDir = PUBLIC_DIR, log = () => {} }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/state') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
        if (!ctx.deployment) return send(res, 503, { ok: false, error: 'NotDeployed', message: 'no deployment loaded yet: start the kit with npm start' });
        return send(res, 200, await getState(ctx));
      }
      if (url.pathname === '/api/templates') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
        return send(res, 200, templatesReport(ctx));
      }
      if (url.pathname === '/api/actions') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!ctx.deployment) return send(res, 503, { ok: false, error: 'NotDeployed', message: 'no deployment loaded yet: start the kit with npm start' });
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') {
          return send(res, 415, { ok: false, error: 'UnsupportedMediaType', message: 'send the body as JSON with the header content-type: application/json' });
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {
          if (e instanceof HttpError) {
            return send(res, e.status, { ok: false, error: e.error, message: e.message }, JSON_TYPE, { connection: 'close' });
          }
          return send(res, 400, { ok: false, error: 'BadRequest', message: 'body must be JSON: {"action": ..., "actor": ..., "params": {...}}' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') {
          return send(res, 400, { ok: false, error: 'BadRequest', message: 'body must be {"action": string, "actor"?: string, "params"?: object}' });
        }
        if (body.actor !== undefined && body.actor !== null && typeof body.actor !== 'string') {
          return send(res, 400, { ok: false, error: 'BadRequest', message: 'actor must be a cast id such as "issuer"' });
        }
        const result = await runAction(ctx, { action: body.action, actor: body.actor ?? undefined, params: body.params ?? {} });
        log(`${body.action} by ${body.actor ?? '(default actor)'}: ${result.ok ? 'ok' : `refused (${result.error})`}`);
        const status = !result.ok && (result.error === 'UnknownAction' || result.error === 'BadRequest') ? 400 : 200;
        return send(res, status, result);
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'NotFound' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
      return await serveStatic(res, publicDir, url.pathname);
    } catch (e) {
      log(`error on ${req.method} ${url.pathname}: ${e.message}`);
      if (res.headersSent) return res.end();
      return send(res, 500, { ok: false, error: 'ServerError', message: e.shortMessage ?? e.message });
    }
  };
}

/**
 * Starts the console server. Signature kept stable for the console milestone.
 * @param {{ctx: object, port?: number, host?: string, publicDir?: string, log?: (m: string) => void}} o
 * @returns {Promise<{server: http.Server, url: string, port: number, close: () => Promise<void>}>}
 */
export async function startServer({ ctx, port = 3000, host = process.env.HOST ?? '127.0.0.1', publicDir = PUBLIC_DIR, log = () => {} }) {
  const server = http.createServer(createHandler({ ctx, publicDir, log }));
  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') reject(new Error(`port ${port} is already in use: set PORT to another port`));
      else reject(e);
    });
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    server,
    port: actual,
    url: `http://${shownHost}:${actual}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// `node examples/server.mjs` serves an existing deployment (from deployments/<network>.json) without redeploying.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { openDeployment } = await import('./lib/context.mjs');
  const { loadEnv } = await import('./lib/network.mjs');
  const env = loadEnv();
  const ctx = await openDeployment({ env });
  const s = await startServer({ ctx, port: Number(env.PORT ?? 3000), log: (m) => console.log(m) });
  console.log(`Console listening on ${s.url}`);
}
