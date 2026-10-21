import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addonBuilder, type Manifest } from 'stremio-addon-sdk';
import { AddonService, PAGE_SIZE, type MetaPreview } from '../addon/addon.js';
import { SORT_MODES, type StremioType, type UserConfig } from '../addon/userConfig.js';
import type { PlatformDef } from '../config/platforms.js';
import type { SortMode, Store } from '../db/store.js';
import { buildStatus } from '../server/status.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('export');

export interface ExportOptions {
  outDir: string;
  /** Carpeta con la página de configuración estática (se copia a la raíz del sitio). */
  siteTemplateDir: string;
  /** Hoja de estilos compartida con la página del servidor. */
  sharedCssFile: string;
  region: string;
  language: string;
  sorts: SortMode[];
  /** Páginas de 100 títulos por catálogo (y por género). Más allá, el catálogo termina. */
  maxPages: number;
  /** Recorta las sinopsis a este número de caracteres (0 = completas). */
  descriptionMax: number;
  now?: () => number;
}

export interface ExportReport {
  addons: number;
  files: number;
  bytes: number;
  truncatedCatalogs: number;
  skippedGenres: string[];
}

/** Caracteres que no pueden ir en un nombre de archivo (Windows) o en un segmento de ruta. */
const UNSAFE_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Genera un sitio estático equivalente al servidor: un addon por plataforma y orden, con todas sus
 * respuestas de catálogo como archivos JSON en las rutas exactas que pide Stremio
 * (`/catalog/{type}/{id}/{extra}.json`, con los valores ya decodificados en el nombre del archivo).
 */
export function exportStaticSite(store: Store, platforms: PlatformDef[], opts: ExportOptions): ExportReport {
  const now = opts.now ?? Date.now;
  const report: ExportReport = { addons: 0, files: 0, bytes: 0, truncatedCatalogs: 0, skippedGenres: [] };
  const limits = { platformKeys: platforms.map((p) => p.key), regions: [opts.region], languages: [opts.language] };
  const addon = new AddonService(store, platforms, limits, now);
  const available = addon.availablePlatforms(opts.region);

  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(opts.outDir, { recursive: true });

  const write = (rel: string, data: unknown) => {
    const file = path.join(opts.outDir, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    writeFileSync(file, body);
    report.files++;
    report.bytes += Buffer.byteLength(body);
  };

  const sitePlatforms: Array<{ key: string; name: string }> = [];
  for (const p of available) {
    let hasContent = false;
    for (const sort of opts.sorts) {
      const cfg: UserConfig = { platforms: [p.key], types: ['movie', 'series'], region: opts.region, language: opts.language, sort, layout: 'platform' };
      const base = `${p.key}/${sort}`;
      const manifest = staticManifest(addon.getInterface(cfg).iface.manifest, p, sort);
      write(`${base}/manifest.json`, manifest);
      // Botón «Configurar» de Stremio: abre {base}/configure → página principal con esta plataforma marcada.
      write(`${base}/configure/index.html`, redirectPage(`../../../index.html?platform=${encodeURIComponent(p.key)}&sort=${sort}`));
      report.addons++;

      for (const cat of manifest.catalogs) {
        const type = cat.type as StremioType;
        const dir = `${base}/catalog/${type}`;
        const genres = cat.extra?.find((e) => e.name === 'genre')?.options ?? [];
        const pages = (genre: string | undefined, files: (skip: number) => string[]) => {
          for (let page = 0; ; page++) {
            const skip = page * PAGE_SIZE;
            if (page >= opts.maxPages) {
              // Página vacía tras el límite: Stremio entiende que el catálogo termina.
              for (const f of files(skip)) write(f, { metas: [] });
              report.truncatedCatalogs++;
              break;
            }
            const metas = addon.catalog(cfg, type, cat.id, { ...(genre ? { genre } : {}), ...(skip ? { skip: String(skip) } : {}) }).metas
              .map((m) => slimMeta(m, opts.descriptionMax));
            if (metas.length) hasContent = true;
            for (const f of files(skip)) write(f, { metas });
            if (metas.length < PAGE_SIZE) break;
          }
        };
        pages(undefined, (skip) => [skip ? `${dir}/${cat.id}/skip=${skip}.json` : `${dir}/${cat.id}.json`]);
        for (const g of genres) {
          if (UNSAFE_FILENAME.test(g)) {
            report.skippedGenres.push(`${cat.id}:${g}`);
            continue;
          }
          // stremio-core (ExtraExt::extend_one) coloca primero el extra que se añade: la página siguiente
          // de un género se pide como "skip=100&genre=Drama".
          pages(g, (skip) => [skip ? `${dir}/${cat.id}/skip=${skip}&genre=${g}.json` : `${dir}/${cat.id}/genre=${g}.json`]);
        }
      }
    }
    if (hasContent) sitePlatforms.push({ key: p.key, name: p.name });
  }

  // Página de configuración y datos que lee.
  cpSync(opts.siteTemplateDir, opts.outDir, { recursive: true });
  cpSync(opts.sharedCssFile, path.join(opts.outDir, 'assets', 'configure.css'));
  write('site.json', {
    generatedAt: now(),
    region: opts.region,
    language: opts.language,
    maxTitlesPerCatalog: opts.maxPages * PAGE_SIZE,
    sorts: opts.sorts.map((code) => ({ code, name: SORT_MODES[code] })),
    platforms: sitePlatforms,
    status: buildStatus(store, platforms, [opts.region]),
  });
  // Sin Jekyll: GitHub Pages publica los archivos tal cual.
  write('.nojekyll', '');

  log.info('Sitio estático generado', { ...report, mb: Math.round(report.bytes / 1e5) / 10 });
  return report;
}

function staticManifest(base: Manifest, p: PlatformDef, sort: SortMode): Manifest {
  const manifest: Manifest = {
    ...base,
    // Un ID por plataforma: instalar otro orden de la misma plataforma sustituye al anterior.
    id: `org.streaminghub.${p.key}`,
    name: `Streaming Hub · ${p.name}`,
    description: `${p.name} en España por ${SORT_MODES[sort].toLowerCase()} (datos de TMDB). Solo catálogos: la reproducción sigue en tus addons habituales.`,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
  // Validación con el SDK oficial (lanza si el manifiesto no es válido).
  new addonBuilder(JSON.parse(JSON.stringify(manifest))).defineCatalogHandler(async () => ({ metas: [] })).getInterface();
  return manifest;
}

/** Vista previa más ligera: sin fondo (Cinemeta lo aporta al abrir la ficha) y con la sinopsis recortada. */
function slimMeta(m: MetaPreview, descriptionMax: number): MetaPreview {
  const { background: _background, ...rest } = m;
  if (descriptionMax > 0 && rest.description && rest.description.length > descriptionMax) {
    rest.description = rest.description.slice(0, descriptionMax - 1).trimEnd() + '…';
  }
  return rest;
}

function redirectPage(target: string): string {
  const t = target.replace(/"/g, '&quot;');
  return `<!doctype html><meta charset="utf-8"><title>Streaming Hub</title><meta http-equiv="refresh" content="0; url=${t}"><a href="${t}">Configurar Streaming Hub</a>`;
}
