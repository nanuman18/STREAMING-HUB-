import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addonBuilder, type Manifest, type ManifestCatalog } from 'stremio-addon-sdk';
import { AddonService, MANIFEST_BUDGET, PAGE_SIZE, toTmdbType, type MetaPreview } from '../addon/addon.js';
import type { StremioType, UserConfig } from '../addon/userConfig.js';
import type { PlatformDef } from '../config/platforms.js';
import type { Store } from '../db/store.js';
import { buildStatus } from '../server/status.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('export');

export const HUB_ID = 'org.streaminghub.hub';
/** Catálogo de la fila de Inicio con un icono por plataforma. */
export const PLATFORMS_CATALOG = 'plataformas';
export const PLATFORM_TYPE = 'other' as const;
export const PLATFORM_ID_PREFIX = 'shub-';
/** Primera opción del filtro obligatorio: el catálogo completo. */
export const ALL_OPTION = 'Todo';

const IMG = 'https://image.tmdb.org/t/p';

export interface ExportOptions {
  outDir: string;
  /** Carpeta con la página de instalación (se copia a la raíz del sitio). */
  siteTemplateDir: string;
  /** Hoja de estilos compartida con la página del servidor. */
  sharedCssFile: string;
  /** URL pública del sitio (https://usuario.github.io/repo/). Necesaria para los enlaces internos de Stremio. */
  baseUrl: string;
  region: string;
  language: string;
  /** Páginas de 100 títulos por catálogo (y por género). Más allá, el catálogo termina. */
  maxPages: number;
  /** Recorta las sinopsis a este número de caracteres (0 = completas). */
  descriptionMax: number;
  now?: () => number;
}

export interface ExportReport {
  platforms: number;
  files: number;
  bytes: number;
  truncatedCatalogs: number;
  skippedGenres: string[];
  warnings: string[];
}

/** Caracteres que no pueden ir en un nombre de archivo (Windows) o en un segmento de ruta. */
const UNSAFE_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Genera un addon estático con este recorrido en Stremio:
 *   Inicio → fila «Plataformas» (un icono por plataforma) → ficha de la plataforma
 *   → enlaces «Películas» / «Series» → Descubrir, ordenado por fecha de estreno.
 *
 * Los catálogos de cada plataforma llevan el filtro `genre` obligatorio (primera opción «Todo»):
 * así Stremio no los pone como filas en Inicio y solo aparecen al entrar desde la ficha o en Descubrir.
 */
export function exportStaticSite(store: Store, platforms: PlatformDef[], opts: ExportOptions): ExportReport {
  const now = opts.now ?? Date.now;
  const report: ExportReport = { platforms: 0, files: 0, bytes: 0, truncatedCatalogs: 0, skippedGenres: [], warnings: [] };
  const baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/';
  const manifestUrl = `${baseUrl}manifest.json`;
  const limits = { platformKeys: platforms.map((p) => p.key), regions: [opts.region], languages: [opts.language] };
  const addon = new AddonService(store, platforms, limits, now);

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

  const status = buildStatus(store, platforms, [opts.region]);
  const counts = new Map((status.regions[0]?.catalogs ?? []).map((c) => [`${c.platform}/${c.type}`, c.visible]));
  const logos = platformLogos(store, opts.region);
  const types: StremioType[] = ['movie', 'series'];

  // Plataformas con títulos visibles, en el orden de platforms.json.
  const active = addon.availablePlatforms(opts.region).filter((p) => types.some((t) => (counts.get(`${p.key}/${t}`) ?? 0) > 0));
  const cfg: UserConfig = {
    platforms: active.map((p) => p.key), types, region: opts.region, language: opts.language, sort: 'release', layout: 'platform',
  };

  // ------------------------------------------------------------ manifiesto
  const genreLists = new Map<string, string[]>();
  for (const p of active) {
    for (const t of types) genreLists.set(`${p.key}.${t}`, addon.catalogGenreNames(opts.region, p.key, toTmdbType(t), opts.language));
  }
  const build = (maxGenres: number): Manifest => ({
    id: HUB_ID,
    version: addon.version,
    name: 'Streaming Hub',
    description: `Catálogos de ${active.length} plataformas en España, del estreno más reciente al más antiguo (datos de TMDB). Sin enlaces de reproducción: usa tus addons habituales.`,
    resources: ['catalog', { name: 'meta', types: [PLATFORM_TYPE], idPrefixes: [PLATFORM_ID_PREFIX] }],
    types: [PLATFORM_TYPE, ...types],
    catalogs: [
      { type: PLATFORM_TYPE, id: PLATFORMS_CATALOG, name: 'Plataformas' },
      ...active.flatMap((p) => types.filter((t) => (counts.get(`${p.key}/${t}`) ?? 0) > 0).map((t): ManifestCatalog => {
        const genres = (genreLists.get(`${p.key}.${t}`) ?? []).slice(0, maxGenres).sort((a, b) => a.localeCompare(b, 'es'));
        return { type: t, id: `${p.key}.${t}`, name: p.name, extra: [{ name: 'genre', isRequired: true, options: [ALL_OPTION, ...genres] }, { name: 'skip' }] };
      })),
    ],
    behaviorHints: { configurable: true, configurationRequired: false },
  });
  const longest = Math.max(0, ...[...genreLists.values()].map((g) => g.length));
  let manifest: Manifest | null = null;
  for (let n = longest; n >= 0; n--) {
    const m = build(n);
    if (JSON.stringify(m).length <= MANIFEST_BUDGET) {
      if (n < longest) report.warnings.push(`Límite de 8 KB del manifiesto: cada catálogo ofrece sus ${n} géneros más frecuentes`);
      manifest = m;
      break;
    }
  }
  if (!manifest) throw new Error('El manifiesto supera 8 KB incluso sin géneros');
  new addonBuilder(JSON.parse(JSON.stringify(manifest)))
    .defineCatalogHandler(async () => ({ metas: [] }))
    .defineMetaHandler(async () => ({ meta: null }))
    .getInterface();
  write('manifest.json', manifest);
  // Botón «Configurar» de Stremio: abre {base}/configure.
  write('configure/index.html', redirectPage('../index.html'));

  // ----------------------------------------- fila de plataformas y sus fichas
  const tiles: MetaPreview[] = [];
  for (const p of active) {
    const movies = counts.get(`${p.key}/movie`) ?? 0;
    const series = counts.get(`${p.key}/series`) ?? 0;
    const summary = [movies ? `${fmt(movies)} películas` : '', series ? `${fmt(series)} series` : ''].filter(Boolean).join(' · ');
    const logo = logos.get(p.key);
    const id = `${PLATFORM_ID_PREFIX}${p.key}`;
    const poster = logo ? `${IMG}/w500${logo}` : undefined;
    tiles.push({ id, type: PLATFORM_TYPE, name: p.name, ...(poster ? { poster } : {}), posterShape: 'square', description: summary });

    const links = types.filter((t) => (t === 'movie' ? movies : series) > 0).map((t) => ({
      name: t === 'movie' ? `Películas de ${p.name}` : `Series de ${p.name}`,
      category: 'Ver catálogo',
      url: `stremio:///discover/${encodeURIComponent(manifestUrl)}/${t}/${encodeURIComponent(`${p.key}.${t}`)}?genre=${encodeURIComponent(ALL_OPTION)}`,
    }));
    const top = addon.catalog({ ...cfg, sort: 'popularity' }, movies ? 'movie' : 'series', `${p.key}.${movies ? 'movie' : 'series'}`).metas[0];
    write(`meta/${PLATFORM_TYPE}/${id}.json`, {
      meta: {
        id,
        type: PLATFORM_TYPE,
        name: p.name,
        ...(poster ? { poster } : {}),
        posterShape: 'square',
        ...(top?.background ? { background: top.background } : {}),
        description: `${summary} disponibles en España. Pulsa «Películas» o «Series» para verlos del estreno más reciente al más antiguo.`,
        links,
      },
    });
  }
  write(`catalog/${PLATFORM_TYPE}/${PLATFORMS_CATALOG}.json`, { metas: tiles });

  // --------------------------------------------- catálogos de cada plataforma
  for (const cat of manifest.catalogs.filter((c) => c.type !== PLATFORM_TYPE)) {
    const type = cat.type as StremioType;
    const dir = `catalog/${type}/${cat.id}`;
    const options = cat.extra?.find((e) => e.name === 'genre')?.options ?? [];
    for (const option of options) {
      if (UNSAFE_FILENAME.test(option)) {
        report.skippedGenres.push(`${cat.id}:${option}`);
        continue;
      }
      const genre = option === ALL_OPTION ? undefined : option;
      for (let page = 0; ; page++) {
        const skip = page * PAGE_SIZE;
        // stremio-core (ExtraExt::extend_one) coloca primero el extra que se añade: "skip=100&genre=Todo".
        const file = skip ? `${dir}/skip=${skip}&genre=${option}.json` : `${dir}/genre=${option}.json`;
        if (page >= opts.maxPages) {
          // Página vacía tras el límite: Stremio entiende que el catálogo termina.
          write(file, { metas: [] });
          report.truncatedCatalogs++;
          break;
        }
        const metas = addon.catalog(cfg, type, cat.id, { ...(genre ? { genre } : {}), ...(skip ? { skip: String(skip) } : {}) }).metas
          .map((m) => slimMeta(m, opts.descriptionMax));
        write(file, { metas });
        if (metas.length < PAGE_SIZE) break;
      }
    }
  }
  report.platforms = active.length;

  // ------------------------------------------------ página de instalación
  cpSync(opts.siteTemplateDir, opts.outDir, { recursive: true });
  cpSync(opts.sharedCssFile, path.join(opts.outDir, 'assets', 'configure.css'));
  write('site.json', {
    generatedAt: now(),
    region: opts.region,
    manifestUrl,
    maxTitlesPerCatalog: opts.maxPages * PAGE_SIZE,
    platforms: active.map((p) => ({ key: p.key, name: p.name, logo: logos.get(p.key) ? `${IMG}/w154${logos.get(p.key)}` : null })),
    status,
  });
  // Sin Jekyll: GitHub Pages publica los archivos tal cual.
  write('.nojekyll', '');

  log.info('Sitio estático generado', { ...report, mb: Math.round(report.bytes / 1e5) / 10 });
  return report;
}

/** Logo de cada plataforma: el del proveedor de TMDB con mayor prioridad de visualización en la región. */
function platformLogos(store: Store, region: string): Map<string, string> {
  const providers = store.providers(region);
  const out = new Map<string, string>();
  for (const [platform, r] of store.platformProviders(region)) {
    const best = providers
      .filter((p) => r.ids.includes(p.provider_id) && p.logo_path)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0];
    if (best?.logo_path) out.set(platform, best.logo_path);
  }
  return out;
}

/** Vista previa más ligera: sin fondo (Cinemeta lo aporta al abrir la ficha) y con la sinopsis recortada. */
function slimMeta(m: MetaPreview, descriptionMax: number): MetaPreview {
  const { background: _background, ...rest } = m;
  if (descriptionMax > 0 && rest.description && rest.description.length > descriptionMax) {
    rest.description = rest.description.slice(0, descriptionMax - 1).trimEnd() + '…';
  }
  return rest;
}

const fmt = (n: number) => n.toLocaleString('es-ES');

function redirectPage(target: string): string {
  const t = target.replace(/"/g, '&quot;');
  return `<!doctype html><meta charset="utf-8"><title>Streaming Hub</title><meta http-equiv="refresh" content="0; url=${t}"><a href="${t}">Configurar Streaming Hub</a>`;
}
