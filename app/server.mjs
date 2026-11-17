// Minimal console server (node:http, no framework). The keys stay here (decision D7); the browser only
// ever sees getState() and action results, which hold addresses and transaction hashes, never keys.
//
//   GET  /api/state    -> getState(ctx)
//   POST /api/actions  -> body {action, actor, params} -> runAction (the shared action library)
//   GET  /*            -> static files from app/public/ (if present)
//
// Status codes: 200 for state and for any action that was executed or refused on chain ({ok:false, reasons}),
// 400 for a malformed request or an unknown action, 503 when no deployment is loaded, 500 otherwise.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getState, runAction } from './actions/index.mjs';
import { PUBLIC_DIR } from './lib/paths.mjs';

const MAX_BODY = 64 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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
  const file = path.resolve(publicDir, `.${rel}`);
  if (!file.startsWith(path.resolve(publicDir) + path.sep)) return send(res, 404, { ok: false, error: 'NotFound' });
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

/** Builds the request handler. Exported so another module can mount it or extend it. */
export function createHandler({ ctx, publicDir = PUBLIC_DIR, log = () => {} }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/state') {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'MethodNotAllowed' });
        if (!ctx.deployment) return send(res, 503, { ok: false, error: 'NotDeployed', message: 'no deployment loaded yet' });
        return send(res, 200, await getState(ctx));
      }
      if (url.pathname === '/api/actions') {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'MethodNotAllowed' });
        if (!ctx.deployment) return send(res, 503, { ok: false, error: 'NotDeployed', message: 'no deployment loaded yet' });
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {
          if (e.status) return send(res, e.status, { ok: false, error: 'BadRequest', message: e.message });
          return send(res, 400, { ok: false, error: 'BadRequest', message: 'body must be JSON: {"action": ..., "actor": ..., "params": {...}}' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') {
          return send(res, 400, { ok: false, error: 'BadRequest', message: 'body must be {"action": string, "actor"?: string, "params"?: object}' });
        }
        if (body.actor !== undefined && typeof body.actor !== 'string') {
          return send(res, 400, { ok: false, error: 'BadRequest', message: 'actor must be a cast id such as "issuer"' });
        }
        const result = await runAction(ctx, { action: body.action, actor: body.actor, params: body.params ?? {} });
        log(`${body.action} by ${body.actor ?? '(default actor)'}: ${result.ok ? 'ok' : `refused (${result.error})`}`);
        const status = !result.ok && (result.error === 'UnknownAction' || result.error === 'BadRequest') ? 400 : 200;
        return send(res, status, result);
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'NotFound' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: 'MethodNotAllowed' });
      return serveStatic(res, publicDir, url.pathname);
    } catch (e) {
      log(`error on ${req.method} ${url.pathname}: ${e.message}`);
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

// `node app/server.mjs` serves an existing deployment (from deployments/<network>.json) without redeploying.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { openDeployment } = await import('./lib/context.mjs');
  const { loadEnv } = await import('./lib/network.mjs');
  const env = loadEnv();
  const ctx = await openDeployment({ env });
  const s = await startServer({ ctx, port: Number(env.PORT ?? 3000), log: (m) => console.log(m) });
  console.log(`Console listening on ${s.url}`);
}
