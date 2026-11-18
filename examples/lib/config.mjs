// The examples' view of the core config loader: the same functions, with the repository's own cast file and template
// directory as defaults. The core itself has no defaults: it validates whatever cast and templates it is given.
import path from 'node:path';
import { loadKitConfig as loadCast, listTemplateFiles as listFiles } from '../../core/lib/config.mjs';
import { ROOT } from '../../core/lib/paths.mjs';

export * from '../../core/lib/config.mjs';

export const DEFAULT_KIT_CONFIG = path.join(ROOT, 'kit.config.json');
export const DEFAULT_TEMPLATE_DIR = path.join(ROOT, 'templates');

/** Reads and validates the demo cast (default: kit.config.json at the repository root). */
export function loadKitConfig(file = DEFAULT_KIT_CONFIG) {
  return loadCast(file);
}

/** Every *.json file in the given directories (default: templates/). */
export function listTemplateFiles(templateDirs = [DEFAULT_TEMPLATE_DIR]) {
  return listFiles(templateDirs);
}
