import { createContext } from './context.js';
import { Scheduler } from './sync/scheduler.js';
import { createApp } from './server/app.js';
import { createLogger } from './util/logger.js';

const log = createLogger('main');
const ctx = createContext();
const { env, store, platforms, sync } = ctx;

store.failStaleRuns(Date.now());

const enabledPlatforms = env.sync.onlyPlatforms ? platforms.filter((p) => env.sync.onlyPlatforms!.includes(p.key)) : platforms;
const { app } = createApp({
  store,
  platforms: enabledPlatforms,
  limits: {
    platformKeys: enabledPlatforms.map((p) => p.key),
    regions: env.regions,
    languages: [env.language],
  },
  syncRunning: () => sync.isRunning,
  staleAfterHours: Math.max(48, env.sync.fullHours * 2),
});

const server = app.listen(env.port, env.host, () => {
  const base = env.publicUrl ?? `http://127.0.0.1:${env.port}`;
  log.info(`Streaming Hub escuchando en ${env.host}:${env.port}`);
  log.info(`Configuración: ${base}/configure`);
  log.info(`Manifiesto por defecto: ${base}/manifest.json`);
});

let scheduler: Scheduler | null = null;
if (env.sync.enabled) {
  scheduler = new Scheduler(store, sync, { incrementalHours: env.sync.incrementalHours, fullHours: env.sync.fullHours });
  scheduler.start();
  log.info(`Sincronización automática: incremental cada ${env.sync.incrementalHours} h, completa cada ${env.sync.fullHours} h`);
} else {
  log.warn('SYNC_ENABLED=false: no se sincronizará automáticamente (usa npm run sync)');
}

const shutdown = (signal: string) => {
  log.info(`Recibida ${signal}, cerrando`);
  scheduler?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
