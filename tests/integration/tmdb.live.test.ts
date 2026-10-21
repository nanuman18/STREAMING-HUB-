/**
 * Pruebas de integración con endpoints REALES de TMDB (y Cinemeta para la compatibilidad de fichas).
 * Requieren TMDB_ACCESS_TOKEN o TMDB_API_KEY (en .env o en el entorno). Sin credenciales se omiten.
 *   npm run test:integration
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddonService } from '../../src/addon/addon.js';
import { defaultConfig, encodeConfig, type ConfigLimits } from '../../src/addon/userConfig.js';
import { loadDotEnv, readEnv } from '../../src/config/env.js';
import { loadPlatforms } from '../../src/config/platforms.js';
import { openDatabase } from '../../src/db/database.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server/app.js';
import { matchPlatforms } from '../../src/sync/providers.js';
import { offeredBy, SyncService } from '../../src/sync/service.js';
import { TmdbClient, TmdbError } from '../../src/tmdb/client.js';

loadDotEnv(path.resolve(import.meta.dirname, '../../.env'));
const env = readEnv();
const hasCreds = !!(env.tmdb.accessToken || env.tmdb.apiKey);
const PLATFORMS = loadPlatforms(path.resolve(import.meta.dirname, '../../config/platforms.json'));

const tmdb = hasCreds
  ? new TmdbClient({ accessToken: env.tmdb.accessToken, apiKey: env.tmdb.apiKey, maxRps: 20, concurrency: 6 })
  : (null as unknown as TmdbClient);

describe.skipIf(!hasCreds)('TMDB real', () => {
  it('resuelve las 12 plataformas en España con ID reales de TMDB', async () => {
    const [movie, tv] = await Promise.all([tmdb.watchProviders('movie', 'ES', 'es-ES'), tmdb.watchProviders('tv', 'ES', 'es-ES')]);
    const resolved = matchPlatforms(PLATFORMS, [...movie, ...tv]);
    const missing = PLATFORMS.filter((p) => !resolved.has(p.key)).map((p) => p.key);
    expect(missing).toEqual([]);
    // Ningún proveedor de alquiler/canal se cuela en plataformas de suscripción.
    for (const r of resolved.values()) {
      expect(r.providerNames.some((n) => /Amazon Channel|Apple TV Store|Amazon Video$/i.test(n))).toBe(false);
    }
    console.log(Object.fromEntries([...resolved].map(([k, r]) => [k, r.providerIds.join('|') + ' ' + JSON.stringify(r.providerNames)])));
  });

  it('obtiene IMDb ID reales mediante external_ids', async () => {
    expect(await tmdb.imdbId('movie', 550)).toBe('tt0137523');
    expect(await tmdb.imdbId('tv', 1396)).toBe('tt0903747');
  });

  it('Discover corta en la página 500 (motivo de la partición por fechas) y el error no se reintenta', async () => {
    const before = tmdb.requests;
    const err = await tmdb.discover('movie', { region: 'ES', language: 'es-ES', providers: [8], monetization: ['flatrate'], sortBy: 'popularity.desc', page: 501 }).catch((e) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect([400, 422]).toContain(err.status);
    expect(tmdb.requests - before).toBe(1);
  });
});

describe.skipIf(!hasCreds)('versión mínima con datos reales: Netflix y Disney+', () => {
  let dir: string;
  let store: Store;
  let addon: AddonService;
  const limits: ConfigLimits = { platformKeys: ['netflix', 'disney'], regions: ['ES'], languages: ['es-ES'] };
  const platforms = PLATFORMS.filter((p) => limits.platformKeys.includes(p.key));

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-it-'));
    store = new Store(openDatabase(path.join(dir, 'it.db')));
    const sync = new SyncService(store, tmdb, platforms, {
      regions: ['ES'], language: 'es-ES', monetization: ['flatrate', 'free', 'ads'],
      incrementalPages: 2, maxPagesPerQuery: 3, onlyPlatforms: null, imdbRetryDays: 3,
    });
    const report = await sync.run('full');
    expect(report.status).not.toBe('failed');
    addon = new AddonService(store, platforms, limits);
  });

  afterAll(() => {
    store?.db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('el manifiesto es válido y tiene 4 catálogos', () => {
    const { iface } = addon.getInterface(defaultConfig(limits));
    expect(iface.manifest.catalogs.map((c) => c.id)).toEqual(['netflix.movie', 'netflix.series', 'disney.movie', 'disney.series']);
    expect(iface.manifest.resources).toEqual(['catalog']);
  });

  for (const [type, id] of [['movie', 'netflix.movie'], ['series', 'netflix.series'], ['movie', 'disney.movie'], ['series', 'disney.series']] as const) {
    it(`${id}: devuelve títulos con IMDb ID válido`, () => {
      const { metas } = addon.catalog(defaultConfig(limits), type, id);
      expect(metas.length).toBeGreaterThan(20);
      for (const m of metas) {
        expect(m.id).toMatch(/^tt\d{7,}$/);
        expect(m.type).toBe(type);
        expect(m.name.length).toBeGreaterThan(0);
      }
    });
  }

  it('los títulos devueltos están realmente en la plataforma según su ficha de TMDB', async () => {
    const providers = store.platformProviders('ES');
    for (const [platform, type, sType] of [['netflix', 'movie', 'movie'], ['disney', 'tv', 'series']] as const) {
      const ids = new Set(providers.get(platform)!.ids);
      const rows = store.listCatalog({ region: 'ES', platform, type, sort: 'popularity', skip: 0, limit: 5, today: new Date().toISOString().slice(0, 10) });
      expect(rows.length).toBe(5);
      let ok = 0;
      for (const r of rows) {
        const offers = await tmdb.titleOffers(type, r.tmdb_id);
        if (offeredBy(offers.ES, ids, ['flatrate', 'free', 'ads'])) ok++;
      }
      // Discover y la ficha individual provienen de la misma fuente; se toleran desfases puntuales.
      expect(ok, `${platform}/${sType}`).toBeGreaterThanOrEqual(4);
    }
  });

  it('las fichas abren en Cinemeta (lo que permite a otros addons responder al ID)', async () => {
    let found = 0;
    const samples = [
      ...addon.catalog(defaultConfig(limits), 'movie', 'netflix.movie').metas.slice(0, 3),
      ...addon.catalog(defaultConfig(limits), 'series', 'netflix.series').metas.slice(0, 3),
    ];
    for (const m of samples) {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${m.type}/${m.id}.json`);
      const j = (await res.json()) as { meta?: { id?: string } };
      if (j.meta?.id === m.id) found++;
    }
    // Cinemeta puede tardar en indexar estrenos muy recientes.
    expect(found).toBeGreaterThanOrEqual(4);
  });

  it('filtro por género real desde el manifiesto', () => {
    const { manifest } = addon.buildManifest(defaultConfig(limits));
    const genre = manifest.catalogs[0]!.extra!.find((e) => e.name === 'genre')!.options![0]!;
    const { metas } = addon.catalog(defaultConfig(limits), 'movie', 'netflix.movie', { genre });
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.every((m) => m.genres?.includes(genre))).toBe(true);
  });

  it('servidor HTTP: manifiesto configurado y catálogo paginado', async () => {
    const { app } = createApp({ store, platforms, limits });
    const c = encodeConfig({ ...defaultConfig(limits), platforms: ['disney'], types: ['movie'] });
    const m = (await request(app).get(`/${c}/manifest.json`).expect(200)).body;
    expect(m.catalogs.map((x: { id: string }) => x.id)).toEqual(['disney.movie']);
    const p1 = (await request(app).get(`/${c}/catalog/movie/disney.movie.json`).expect(200)).body.metas;
    const p2 = (await request(app).get(`/${c}/catalog/movie/disney.movie/skip=${p1.length}.json`).expect(200)).body.metas;
    const overlap = p1.filter((a: { id: string }) => p2.some((b: { id: string }) => b.id === a.id));
    expect(overlap).toEqual([]);
  });
});
