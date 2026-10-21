/**
 * Genera el sitio estático a partir de la base de datos local (no llama a TMDB):
 *   npm run export -- [--out site]
 * STATIC_BASE_URL debe ser la URL pública donde se publicará (p. ej. https://usuario.github.io/repo/).
 */
import path from 'node:path';
import { loadDotEnv, readEnv } from '../config/env.js';
import { loadPlatforms } from '../config/platforms.js';
import { openDatabase } from '../db/database.js';
import { Store } from '../db/store.js';
import { setLogLevel } from '../util/logger.js';
import { exportStaticSite } from './export.js';

loadDotEnv();
const env = readEnv();
setLogLevel(env.logLevel);

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : 'site');
const root = path.resolve(import.meta.dirname, '../..');

const all = loadPlatforms(env.platformsFile);
const platforms = env.sync.onlyPlatforms ? all.filter((p) => env.sync.onlyPlatforms!.includes(p.key)) : all;
const store = new Store(openDatabase(env.dbPath));
const baseUrl = process.env.STATIC_BASE_URL || 'http://127.0.0.1:7100/';

const report = exportStaticSite(store, platforms, {
  outDir,
  siteTemplateDir: path.join(root, 'public', 'static-site'),
  sharedCssFile: path.join(root, 'public', 'assets', 'configure.css'),
  baseUrl,
  region: env.regions[0] ?? 'ES',
  language: env.language,
  maxPages: Number(process.env.STATIC_MAX_PAGES || 20),
  descriptionMax: Number(process.env.STATIC_DESCRIPTION_MAX || 300),
});
console.log(`Sitio para ${baseUrl} en ${outDir}: ${report.platforms} plataformas, ${report.files} archivos, ${(report.bytes / 1e6).toFixed(1)} MB`);
for (const w of report.warnings) console.log('Aviso:', w);
if (report.skippedGenres.length) console.log('Géneros omitidos por caracteres no válidos en un nombre de archivo:', report.skippedGenres.join(', '));
