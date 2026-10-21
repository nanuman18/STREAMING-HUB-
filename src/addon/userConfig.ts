import type { SortMode } from '../db/store.js';

export type StremioType = 'movie' | 'series';
export type Layout = 'platform' | 'type';

/** Configuración de cada instalación. Viaja codificada en la URL del manifiesto; nunca contiene credenciales. */
export interface UserConfig {
  /** Plataformas activadas, en el orden en que se mostrarán. */
  platforms: string[];
  types: StremioType[];
  region: string;
  language: string;
  sort: SortMode;
  /** Agrupar catálogos por plataforma (Netflix películas, Netflix series...) o por tipo (todas las películas primero). */
  layout: Layout;
}

export const SORT_MODES: Record<SortMode, string> = {
  popularity: 'Popularidad',
  new: 'Novedades detectadas',
  release: 'Fecha de estreno',
  rating: 'Valoración',
};

export const LANGUAGES: Record<string, string> = { 'es-ES': 'Español (España)' };

export interface ConfigLimits {
  platformKeys: string[];
  regions: string[];
  languages: string[];
}

export class ConfigError extends Error {}

export function defaultConfig(limits: ConfigLimits): UserConfig {
  return {
    platforms: [...limits.platformKeys],
    types: ['movie', 'series'],
    region: limits.regions[0] ?? 'ES',
    language: limits.languages[0] ?? 'es-ES',
    sort: 'popularity',
    layout: 'platform',
  };
}

/** Forma compacta que va en la URL. */
interface Encoded {
  p: string[];
  t: StremioType[];
  r: string;
  l: string;
  s: SortMode;
  g: Layout;
}

export function encodeConfig(cfg: UserConfig): string {
  const e: Encoded = { p: cfg.platforms, t: cfg.types, r: cfg.region, l: cfg.language, s: cfg.sort, g: cfg.layout };
  return Buffer.from(JSON.stringify(e), 'utf8').toString('base64url');
}

/** Valida y normaliza. Las plataformas desconocidas se descartan; el resto de valores inválidos son error. */
export function normalizeConfig(raw: Partial<UserConfig>, limits: ConfigLimits): UserConfig {
  const def = defaultConfig(limits);
  const platforms = Array.isArray(raw.platforms)
    ? [...new Set(raw.platforms.filter((p): p is string => typeof p === 'string' && limits.platformKeys.includes(p)))]
    : def.platforms;
  if (platforms.length === 0) throw new ConfigError('Activa al menos una plataforma');
  const types = Array.isArray(raw.types) ? [...new Set(raw.types.filter((t): t is StremioType => t === 'movie' || t === 'series'))] : def.types;
  if (types.length === 0) throw new ConfigError('Elige películas, series o ambos');
  const region = typeof raw.region === 'string' ? raw.region.toUpperCase() : def.region;
  if (!limits.regions.includes(region)) throw new ConfigError(`País no disponible: ${region}`);
  const language = typeof raw.language === 'string' ? raw.language : def.language;
  if (!limits.languages.includes(language)) throw new ConfigError(`Idioma no disponible: ${language}`);
  const sort = raw.sort && raw.sort in SORT_MODES ? raw.sort : def.sort;
  const layout = raw.layout === 'type' ? 'type' : 'platform';
  return { platforms, types, region, language, sort, layout };
}

export function decodeConfig(segment: string, limits: ConfigLimits): UserConfig {
  let e: Partial<Encoded>;
  try {
    e = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new ConfigError('Configuración ilegible en la URL');
  }
  if (!e || typeof e !== 'object') throw new ConfigError('Configuración ilegible en la URL');
  return normalizeConfig(
    {
      ...(e.p !== undefined ? { platforms: e.p } : {}),
      ...(e.t !== undefined ? { types: e.t } : {}),
      ...(e.r !== undefined ? { region: e.r } : {}),
      ...(e.l !== undefined ? { language: e.l } : {}),
      ...(e.s !== undefined ? { sort: e.s } : {}),
      ...(e.g !== undefined ? { layout: e.g } : {}),
    },
    limits,
  );
}
