import { assertTmdbCredentials, loadDotEnv, readEnv, type AppEnv } from './config/env.js';
import { loadPlatforms, type PlatformDef } from './config/platforms.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { TmdbClient } from './tmdb/client.js';
import { SyncService } from './sync/service.js';
import { setLogLevel } from './util/logger.js';

export interface AppContext {
  env: AppEnv;
  store: Store;
  tmdb: TmdbClient;
  platforms: PlatformDef[];
  sync: SyncService;
}

/** Crea las dependencias compartidas por el servidor y la CLI de sincronización. */
export function createContext(): AppContext {
  loadDotEnv();
  const env = readEnv();
  setLogLevel(env.logLevel);
  assertTmdbCredentials(env);
  const platforms = loadPlatforms(env.platformsFile);
  const store = new Store(openDatabase(env.dbPath));
  const tmdb = new TmdbClient({
    accessToken: env.tmdb.accessToken,
    apiKey: env.tmdb.apiKey,
    baseUrl: env.tmdb.baseUrl,
    maxRps: env.tmdb.maxRps,
    concurrency: env.tmdb.concurrency,
    maxRetries: env.tmdb.maxRetries,
  });
  const sync = new SyncService(store, tmdb, platforms, {
    regions: env.regions,
    language: env.language,
    monetization: env.sync.monetization,
    incrementalPages: env.sync.incrementalPages,
    maxPagesPerQuery: env.sync.maxPagesPerQuery,
    onlyPlatforms: env.sync.onlyPlatforms,
    imdbRetryDays: env.sync.imdbRetryDays,
  });
  return { env, store, tmdb, platforms, sync };
}
