// Repository paths. Everything else resolves relative to these, never to the current directory.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = path.join(ROOT, 'out');
export const DEPLOYMENTS_DIR = path.join(ROOT, 'deployments');
export const PUBLIC_DIR = path.join(ROOT, 'app', 'public');
