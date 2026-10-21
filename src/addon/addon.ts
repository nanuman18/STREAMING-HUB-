import { readFileSync } from 'node:fs';
import path from 'node:path';
import { addonBuilder, type AddonInterface, type Manifest, type ManifestCatalog } from 'stremio-addon-sdk';
import type { PlatformDef } from '../config/platforms.js';
import type { CatalogRow, Store } from '../db/store.js';
import type { TmdbMediaType } from '../tmdb/types.js';
import { LruCache } from '../util/lru.js';
import { genreIndex, type GenreIndex } from './genres.js';
import type { ConfigLimits, StremioType, UserConfig } from './userConfig.js';

export const ADDON_ID = 'org.streaminghub.catalogs';
export const PAGE_SIZE = 100;
/** El SDK rechaza manifiestos de más de 8 KB (límite de la API de colecciones de Stremio). */
export const MANIFEST_BUDGET = 8000;
const IMG = 'https://image.tmdb.org/t/p';

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')).version;
  } catch {
    return '1.0.0';
  }
})();

export const toTmdbType = (t: StremioType): TmdbMediaType => (t === 'movie' ? 'movie' : 'tv');
export const toStremioType = (t: TmdbMediaType): StremioType => (t === 'movie' ? 'movie' : 'series');

export interface MetaPreview {
  id: string;
  type: StremioType;
  name: string;
  poster?: string;
  posterShape: 'poster';
  background?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
}

export interface CatalogResponse {
  metas: MetaPreview[];
  cacheMaxAge: number;
  staleRevalidate: number;
  staleError: number;
}

/**
 * Construye, valida (con el SDK oficial) y sirve el addon para cada configuración.
 * Solo declara el recurso `catalog`: no hay stream handler ni meta handler, de modo que al abrir
 * una ficha (ID tt...) Stremio consulta Cinemeta y los addons de reproducción que el usuario tenga.
 */
export class AddonService {
  private readonly interfaces = new LruCache<{ iface: AddonInterface; warnings: string[] }>(200);
  private readonly catalogCache = new LruCache<MetaPreview[]>(2000, 30 * 60_000);
  private cacheVersion = -1;
  private readonly genres = new Map<string, GenreIndex>();
  /** Géneros por catálogo (de más a menos títulos). Es la parte costosa de construir un manifiesto. */
  private readonly genreCounts = new Map<string, number[]>();

  constructor(
    private readonly store: Store,
    private readonly platforms: PlatformDef[],
    private readonly limits: ConfigLimits,
    private readonly now: () => number = Date.now,
  ) {}

  get version(): string {
    return VERSION;
  }

  /** Plataformas que se pueden ofrecer en una región: resueltas en TMDB (o todas si aún no hubo sincronización). */
  availablePlatforms(region: string): PlatformDef[] {
    const resolved = this.store.platformProviders(region);
    if (resolved.size === 0) return this.platforms;
    return this.platforms.filter((p) => resolved.has(p.key));
  }

  private checkVersion(): void {
    const v = this.store.dataVersion();
    if (v !== this.cacheVersion) {
      this.cacheVersion = v;
      this.interfaces.clear();
      this.catalogCache.clear();
      this.genres.clear();
      this.genreCounts.clear();
    }
  }

  private genreIdx(language: string): GenreIndex {
    let idx = this.genres.get(language);
    if (!idx) {
      idx = genreIndex(this.store, language);
      this.genres.set(language, idx);
    }
    return idx;
  }

  getInterface(cfg: UserConfig): { iface: AddonInterface; warnings: string[] } {
    this.checkVersion();
    const key = JSON.stringify(cfg);
    const cached = this.interfaces.get(key);
    if (cached) return cached;
    const { manifest, warnings } = this.buildManifest(cfg);
    const builder = new addonBuilder(manifest);
    builder.defineCatalogHandler(async (args) => this.catalog(cfg, args.type as StremioType, args.id, args.extra));
    const out = { iface: builder.getInterface(), warnings };
    this.interfaces.set(key, out);
    return out;
  }

  buildManifest(cfg: UserConfig): { manifest: Manifest; warnings: string[] } {
    this.checkVersion();
    const available = new Map(this.availablePlatforms(cfg.region).map((p) => [p.key, p]));
    const chosen = cfg.platforms.map((k) => available.get(k)).filter((p): p is PlatformDef => !!p);
    const idx = this.genreIdx(cfg.language);

    const pairs: Array<[PlatformDef, StremioType]> = cfg.layout === 'type'
      ? cfg.types.flatMap((t) => chosen.map((p) => [p, t] as [PlatformDef, StremioType]))
      : chosen.flatMap((p) => cfg.types.map((t) => [p, t] as [PlatformDef, StremioType]));

    // Géneros presentes en cada catálogo, de más a menos títulos.
    const genreLists = pairs.map(([p, t]) =>
      this.catalogGenres(cfg.region, p.key, toTmdbType(t))
        .map((id) => idx.nameOf(toTmdbType(t), id))
        .filter((n): n is string => !!n),
    );

    const build = (maxGenres: number): Manifest => {
      const catalogs: ManifestCatalog[] = pairs.map(([p, t], i) => {
        const options = genreLists[i]!.slice(0, maxGenres).sort((a, b) => a.localeCompare(b, 'es'));
        return {
          type: t,
          id: `${p.key}.${t}`,
          name: `${p.name} — ${t === 'movie' ? 'Películas' : 'Series'}`,
          // isRequired se omite: su valor por defecto es false y así cabe en 8 KB un género más por catálogo.
          extra: [...(options.length ? [{ name: 'genre', options }] : []), { name: 'skip' }],
        };
      });
      return {
        id: ADDON_ID,
        version: VERSION,
        name: 'Streaming Hub',
        description: `Catálogos de ${chosen.length === 1 ? chosen[0]!.name : `${chosen.length} plataformas`} en ${cfg.region} con datos de TMDB. Sin enlaces de reproducción: usa tus addons habituales.`,
        resources: ['catalog'],
        types: [...cfg.types],
        catalogs,
        behaviorHints: { configurable: true, configurationRequired: false },
      };
    };

    const warnings: string[] = [];
    const longest = Math.max(0, ...genreLists.map((g) => g.length));
    for (let n = longest; n >= 0; n--) {
      const m = build(n);
      if (JSON.stringify(m).length <= MANIFEST_BUDGET) {
        if (n < longest) warnings.push(`Para no superar el límite de 8 KB del manifiesto, cada catálogo muestra solo sus ${n} géneros más frecuentes`);
        return { manifest: m, warnings };
      }
    }
    throw new Error('El manifiesto supera 8 KB incluso sin géneros: reduce el número de plataformas');
  }

  private catalogGenres(region: string, platform: string, type: TmdbMediaType): number[] {
    const key = `${region}|${platform}|${type}`;
    let ids = this.genreCounts.get(key);
    if (!ids) {
      ids = this.store.genreCounts(region, platform, type).map((g) => g.genre_id);
      this.genreCounts.set(key, ids);
    }
    return ids;
  }

  /** Respuesta de catálogo. Lee de la BD local (nunca llama a TMDB en la ruta de la petición). */
  catalog(cfg: UserConfig, type: StremioType, catalogId: string, extra: Record<string, string | undefined> = {}): CatalogResponse {
    this.checkVersion();
    const cacheHeaders = { cacheMaxAge: 3600, staleRevalidate: 6 * 3600, staleError: 7 * 86_400 };
    const [platformKey, catType] = catalogId.split('.');
    if (!platformKey || catType !== type || !cfg.types.includes(type) || !cfg.platforms.includes(platformKey)) {
      return { metas: [], ...cacheHeaders };
    }
    const skipRaw = Number(extra.skip ?? 0);
    const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0;
    const tmdbType = toTmdbType(type);
    const idx = this.genreIdx(cfg.language);
    let genreId: number | undefined;
    if (extra.genre) {
      genreId = idx.idOf(tmdbType, extra.genre);
      if (genreId === undefined) return { metas: [], ...cacheHeaders };
    }
    const key = [cfg.region, cfg.language, cfg.sort, catalogId, genreId ?? '', skip].join('|');
    let metas = this.catalogCache.get(key);
    if (!metas) {
      const rows = this.store.listCatalog({
        region: cfg.region, platform: platformKey, type: tmdbType, sort: cfg.sort,
        ...(genreId !== undefined ? { genreId } : {}),
        skip, limit: PAGE_SIZE, today: new Date(this.now()).toISOString().slice(0, 10),
      });
      const genresByTitle = this.store.genreIdsByTitle(tmdbType, rows.map((r) => r.tmdb_id));
      metas = rows.map((r) => toMeta(r, type, (genresByTitle.get(r.tmdb_id) ?? []).map((g) => idx.nameOf(tmdbType, g)).filter((n): n is string => !!n)));
      this.catalogCache.set(key, metas);
    }
    return { metas, ...cacheHeaders };
  }
}

export function toMeta(r: CatalogRow, type: StremioType, genres: string[]): MetaPreview {
  return {
    id: r.imdb_id,
    type,
    name: r.title,
    ...(r.poster_path ? { poster: `${IMG}/w342${r.poster_path}` } : {}),
    posterShape: 'poster',
    ...(r.backdrop_path ? { background: `${IMG}/w1280${r.backdrop_path}` } : {}),
    ...(r.overview ? { description: r.overview } : {}),
    ...(r.year ? { releaseInfo: String(r.year) } : {}),
    ...(genres.length ? { genres } : {}),
  };
}
