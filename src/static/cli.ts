/**
 * Genera el sitio estático a partir de la base de datos local (no llama a TMDB):
 *   npm run export -- [--out site]
 */
import path from 'node:path';
import { SORT_MODES } from '../addon/userConfig.js';
import { loadDotEnv, readEnv } from '../config/env.js';
import { loadPlatforms } from '../config/platforms.js';
import { openDatabase } from '../db/database.js';
import { Store, type SortMode } from '../db/store.js';
import { setLogLevel } from '../util/logger.js';
import { exportStaticSite } from './export.js';

loadDotEnv();
const env = readEnv();
setLogLevel(env.logLevel);

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : 'site');
const root = path.resolve(import.meta.dirname, '../..');

const sorts = (process.env.STATIC_SORTS ?? Object.keys(SORT_MODES).join(','))
  .split(',').map((s) => s.trim()).filter((s): s is SortMode => s in SORT_MODES);
const all = loadPlatforms(env.platformsFile);
const platforms = env.sync.onlyPlatforms ? all.filter((p) => env.sync.onlyPlatforms!.includes(p.key)) : all;
const store = new Store(openDatabase(env.dbPath));

const report = exportStaticSite(store, platforms, {
  outDir,
  siteTemplateDir: path.join(root, 'public', 'static-site'),
  sharedCssFile: path.join(root, 'public', 'assets', 'configure.css'),
  region: env.regions[0] ?? 'ES',
  language: env.language,
  sorts,
  maxPages: Number(process.env.STATIC_MAX_PAGES ?? 10),
  descriptionMax: Number(process.env.STATIC_DESCRIPTION_MAX ?? 300),
});
console.log(`Sitio en ${outDir}: ${report.addons} addons, ${report.files} archivos, ${(report.bytes / 1e6).toFixed(1)} MB`);
if (report.skippedGenres.length) console.log('Géneros omitidos por caracteres no válidos en un nombre de archivo:', report.skippedGenres.join(', '));
