import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { AddonService } from '../addon/addon.js';
import { ConfigError, decodeConfig, defaultConfig, encodeConfig, LANGUAGES, SORT_MODES, type ConfigLimits, type StremioType, type UserConfig } from '../addon/userConfig.js';
import type { PlatformDef } from '../config/platforms.js';
import type { Store } from '../db/store.js';
import { createLogger } from '../util/logger.js';
import { buildStatus } from './status.js';

const log = createLogger('http');

export interface AppDeps {
  store: Store;
  platforms: PlatformDef[];
  limits: ConfigLimits;
  publicDir?: string;
  /** Si existe, la sincronización está en marcha (para /health y /api/status). */
  syncRunning?: () => boolean;
  /** Antigüedad máxima (h) de la última sincronización correcta antes de declarar el servicio "degradado". */
  staleAfterHours?: number;
  now?: () => number;
}

/** Segmento de configuración: base64url. Las rutas reservadas (api, assets...) nunca coinciden con él por la forma de las rutas. */
const CFG = '([A-Za-z0-9_-]{2,2048})';
const MANIFEST_RE = new RegExp(`^/(?:${CFG}/)?manifest\\.json$`);
const CATALOG_RE = new RegExp(`^/(?:${CFG}/)?catalog/([a-z]+)/([^/]+?)(?:/([^/]+))?\\.json$`);
const CONFIGURE_RE = new RegExp(`^/(?:${CFG}/)?configure/?$`);

export function createApp(deps: AppDeps) {
  const app = express();
  const addon = new AddonService(deps.store, deps.platforms, deps.limits);
  const publicDir = deps.publicDir ?? path.resolve(import.meta.dirname, '../../public');

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // CORS es obligatorio en el protocolo de addons de Stremio.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const parseCfg = (segment: string | undefined): UserConfig =>
    segment ? decodeConfig(segment, deps.limits) : defaultConfig(deps.limits);

  const sendError = (res: Response, err: unknown) => {
    if (err instanceof ConfigError) {
      res.status(400).json({ err: err.message });
      return;
    }
    log.error('Error atendiendo petición', { error: (err as Error).message });
    res.status(500).json({ err: 'error interno' });
  };

  // ------------------------------------------------------------- protocolo

  app.get(MANIFEST_RE, (req: Request, res: Response) => {
    try {
      const cfg = parseCfg(req.params[0]);
      const { iface } = addon.getInterface(cfg);
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.json(iface.manifest);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get(CATALOG_RE, async (req: Request, res: Response) => {
    try {
      const m = CATALOG_RE.exec(req.path)!;
      const cfg = parseCfg(m[1]);
      const type = m[2] as StremioType;
      const id = decodeURIComponent(m[3]!);
      // `extra` se toma en bruto para no romper valores con "&" codificado (igual que hace el SDK).
      const extra = m[4] ? Object.fromEntries(new URLSearchParams(m[4])) : {};
      const { iface } = addon.getInterface(cfg);
      const resp = await iface.get('catalog', type, id, extra, cfg);
      res.setHeader('Cache-Control', `public, max-age=${resp.cacheMaxAge}, stale-while-revalidate=${resp.staleRevalidate}, stale-if-error=${resp.staleError}`);
      res.json({ metas: resp.metas });
    } catch (err) {
      sendError(res, err);
    }
  });

  // --------------------------------------------------------- configuración

  app.get(CONFIGURE_RE, (_req, res) => {
    res.sendFile(path.join(publicDir, 'configure.html'));
  });
  app.get('/', (_req, res) => res.redirect('/configure'));
  app.use('/assets', express.static(path.join(publicDir, 'assets'), { maxAge: '5m' }));

  /** Opciones para la página de configuración (sin credenciales). */
  app.get('/api/options', (_req, res) => {
    const regions = deps.limits.regions.map((region) => ({
      code: region,
      platforms: addon.availablePlatforms(region).map((p) => ({ key: p.key, name: p.name })),
    }));
    res.json({
      regions,
      languages: deps.limits.languages.map((code) => ({ code, name: LANGUAGES[code] ?? code })),
      sorts: Object.entries(SORT_MODES).map(([code, name]) => ({ code, name })),
      defaults: defaultConfig(deps.limits),
      version: addon.version,
    });
  });

  /** Codifica una configuración (la página también lo hace en el navegador; esto valida y devuelve el manifiesto resultante). */
  app.post('/api/config', express.json({ limit: '8kb' }), (req, res) => {
    try {
      const cfg = decodeConfig(encodeConfig(req.body as UserConfig), deps.limits);
      const encoded = encodeConfig(cfg);
      const { iface, warnings } = addon.getInterface(cfg);
      res.json({ config: cfg, encoded, path: `/${encoded}/manifest.json`, catalogs: iface.manifest.catalogs.length, warnings });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/status', (_req, res) => {
    res.json(buildStatus(deps.store, deps.platforms, deps.limits.regions, deps.syncRunning?.() ?? false));
  });

  app.get('/health', (_req, res) => {
    try {
      deps.store.ping();
      const lastGood = deps.store.lastRun();
      const staleMs = (deps.staleAfterHours ?? 48) * 3_600_000;
      const stale = !lastGood?.finished_at || (deps.now ?? Date.now)() - lastGood.finished_at > staleMs;
      // El servicio sigue respondiendo con los últimos datos válidos aunque estén desfasados: 200 con estado "degraded".
      res.json({
        status: stale ? 'degraded' : 'ok',
        db: 'ok',
        lastSync: lastGood?.finished_at ? new Date(lastGood.finished_at).toISOString() : null,
        syncing: deps.syncRunning?.() ?? false,
      });
    } catch (err) {
      res.status(503).json({ status: 'error', db: (err as Error).message });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ err: 'not found' });
  });

  return { app, addon };
}
