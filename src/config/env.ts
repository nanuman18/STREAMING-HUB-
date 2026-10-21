import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AppEnv {
  port: number;
  host: string;
  /** URL pública (https://...) con la que se anuncia el addon. Si falta, se deduce de la petición. */
  publicUrl: string | null;
  tmdb: {
    accessToken: string | null;
    apiKey: string | null;
    baseUrl: string;
    /** Peticiones por segundo como máximo hacia TMDB. */
    maxRps: number;
    concurrency: number;
    maxRetries: number;
  };
  dbPath: string;
  platformsFile: string;
  /** Regiones (ISO 3166-1) que se sincronizan. La configuración pública solo ofrece estas. */
  regions: string[];
  /** Idioma de títulos, sinopsis y géneros. */
  language: string;
  sync: {
    enabled: boolean;
    incrementalHours: number;
    fullHours: number;
    /** Páginas por ordenación en la sincronización incremental. */
    incrementalPages: number;
    /** Límite de páginas por consulta (0 = sin límite, hasta el máximo de 500 de TMDB). Útil en desarrollo. */
    maxPagesPerQuery: number;
    /** Si se indica, solo se sincronizan estas plataformas (claves de platforms.json). */
    onlyPlatforms: string[] | null;
    /** Días tras los que se vuelve a buscar el IMDb ID de un título que no lo tenía. */
    imdbRetryDays: number;
    /** Tipos de monetización por defecto (TMDB: flatrate, free, ads, rent, buy). */
    monetization: string[];
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Variable ${name} no es un número: "${raw}"`);
  return n;
}

function list(name: string, def: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(raw.trim().toLowerCase());
}

function str(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? raw.trim() : null;
}

/** Carga .env (si existe) sin dependencias externas. Las variables ya definidas en el entorno tienen prioridad. */
export function loadDotEnv(file = path.resolve('.env')): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function readEnv(): AppEnv {
  const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const only = list('SYNC_PLATFORMS', []);
  return {
    port: int('PORT', 7000),
    host: process.env.HOST ?? '0.0.0.0',
    publicUrl: str('PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
    tmdb: {
      accessToken: str('TMDB_ACCESS_TOKEN'),
      apiKey: str('TMDB_API_KEY'),
      baseUrl: str('TMDB_BASE_URL') ?? 'https://api.themoviedb.org/3',
      maxRps: int('TMDB_MAX_RPS', 30),
      concurrency: int('TMDB_CONCURRENCY', 12),
      maxRetries: int('TMDB_MAX_RETRIES', 5),
    },
    dbPath: str('DB_PATH') ?? path.resolve('data', 'streaming-hub.db'),
    platformsFile: str('PLATFORMS_FILE') ?? path.resolve('config', 'platforms.json'),
    regions: list('SYNC_REGIONS', ['ES']).map((r) => r.toUpperCase()),
    language: str('TMDB_LANGUAGE') ?? 'es-ES',
    sync: {
      enabled: bool('SYNC_ENABLED', true),
      incrementalHours: int('SYNC_INCREMENTAL_HOURS', 6),
      fullHours: int('SYNC_FULL_HOURS', 24),
      incrementalPages: int('SYNC_INCREMENTAL_PAGES', 5),
      maxPagesPerQuery: int('SYNC_MAX_PAGES', 0),
      onlyPlatforms: only.length ? only : null,
      imdbRetryDays: int('IMDB_RETRY_DAYS', 3),
      monetization: list('SYNC_MONETIZATION', ['flatrate', 'free', 'ads']),
    },
    logLevel: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as AppEnv['logLevel'],
  };
}

export function assertTmdbCredentials(env: AppEnv): void {
  if (!env.tmdb.accessToken && !env.tmdb.apiKey) {
    throw new Error('Faltan credenciales de TMDB: define TMDB_ACCESS_TOKEN (recomendado) o TMDB_API_KEY en .env');
  }
}
