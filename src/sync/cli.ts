/**
 * Sincronización manual:  npm run sync -- [--full | --incremental]
 * Por defecto ejecuta la que toque según el calendario (completa si nunca se hizo).
 */
import { createContext } from '../context.js';
import { dueSync } from './scheduler.js';

const ctx = createContext();
const args = process.argv.slice(2);
const kind = args.includes('--full')
  ? 'full'
  : args.includes('--incremental')
    ? 'incremental'
    : (dueSync(ctx.store, { incrementalHours: 0, fullHours: ctx.env.sync.fullHours, failureBackoffMinutes: 0 }, Date.now()) ?? 'incremental');

ctx.store.failStaleRuns(Date.now());
const report = await ctx.sync.run(kind);
const summary = report.catalogs.map((c) => ({
  catalogo: `${c.platform}/${c.type}`,
  recogidos: c.collected,
  totalTmdb: c.totalResults,
  completo: c.complete,
  altas: c.added + c.readded,
  bajas: c.removed,
  errores: c.errors.length,
}));
console.table(summary);
console.log('IMDb:', report.imdb, '| peticiones TMDB:', ctx.tmdb.requests, '| estado:', report.status);
if (report.unresolvedPlatforms.length) console.log('Plataformas sin proveedor en TMDB:', report.unresolvedPlatforms.join(', '));
process.exit(report.status === 'failed' ? 1 : 0);
