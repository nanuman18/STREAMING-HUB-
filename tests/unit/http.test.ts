import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { defaultConfig, encodeConfig } from '../../src/addon/userConfig.js';
import { createApp } from '../../src/server/app.js';
import { makeEnv, PLATFORMS } from '../helpers/setup.js';

async function server() {
  const env = makeEnv();
  for (let i = 1; i <= 120; i++) env.fake.add({ type: 'movie', id: i, popularity: 500 - i, genres: [i % 2 ? 28 : 35] });
  env.fake.add({ type: 'tv', id: 900 });
  env.fake.add({ type: 'movie', id: 950, offers: { ES: { flatrate: [337] } } });
  await env.sync.run('full');
  const { app } = createApp({ store: env.store, platforms: PLATFORMS, limits: env.limits, syncRunning: () => false, now: env.now });
  return { env, app };
}

const SECRET = 'eyJhbGciOiJIUzI1NiJ9.secreto-de-prueba';

describe('HTTP', () => {
  it('sirve el manifiesto por defecto con CORS', async () => {
    const { app } = await server();
    const res = await request(app).get('/manifest.json').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.resources).toEqual(['catalog']);
    expect(res.body.catalogs.length).toBeGreaterThan(0);
  });

  it('configuración individual: cada URL produce su propio manifiesto', async () => {
    const { app, env } = await server();
    const a = encodeConfig({ ...defaultConfig(env.limits), platforms: ['disney'], types: ['movie'] });
    const b = encodeConfig({ ...defaultConfig(env.limits), platforms: ['netflix', 'disney'], types: ['series'], layout: 'type' });
    const ma = (await request(app).get(`/${a}/manifest.json`).expect(200)).body;
    const mb = (await request(app).get(`/${b}/manifest.json`).expect(200)).body;
    expect(ma.catalogs.map((c: { id: string }) => c.id)).toEqual(['disney.movie']);
    expect(mb.catalogs.map((c: { id: string }) => c.id)).toEqual(['netflix.series', 'disney.series']);
  });

  it('catálogo con configuración, género y skip en la ruta (formato del protocolo)', async () => {
    const { app, env } = await server();
    const c = encodeConfig(defaultConfig(env.limits));
    const p1 = (await request(app).get(`/${c}/catalog/movie/netflix.movie.json`).expect(200)).body.metas;
    expect(p1).toHaveLength(100);
    const p2 = (await request(app).get(`/${c}/catalog/movie/netflix.movie/skip=100.json`).expect(200)).body.metas;
    expect(p2).toHaveLength(20);
    const g = await request(app).get(`/${c}/catalog/movie/netflix.movie/genre=Acci%C3%B3n&skip=0.json`).expect(200);
    expect(g.body.metas).toHaveLength(60);
    expect(g.body.metas.every((m: { genres: string[] }) => m.genres.includes('Acción'))).toBe(true);
    expect(g.headers['cache-control']).toMatch(/max-age=3600/);
    // Sin configuración en la URL se usan los valores por defecto.
    const d = (await request(app).get('/catalog/series/netflix.series.json').expect(200)).body.metas;
    expect(d.map((m: { id: string }) => m.id)).toEqual(['tt1000900']);
  });

  it('configuración inválida → 400 con mensaje', async () => {
    const { app, env } = await server();
    await request(app).get('/esto-no-es-config/manifest.json').expect(400);
    const bad = encodeConfig({ ...defaultConfig(env.limits), region: 'FR' });
    const res = await request(app).get(`/${bad}/manifest.json`).expect(400);
    expect(res.body.err).toMatch(/País no disponible/);
    const none = encodeConfig({ ...defaultConfig(env.limits), platforms: ['inventada'] });
    expect((await request(app).get(`/${none}/manifest.json`).expect(400)).body.err).toMatch(/al menos una plataforma/);
  });

  it('página de configuración en /configure y /{config}/configure', async () => {
    const { app, env } = await server();
    await request(app).get('/configure').expect(200).expect('content-type', /html/);
    await request(app).get(`/${encodeConfig(defaultConfig(env.limits))}/configure`).expect(200).expect('content-type', /html/);
    await request(app).get('/').expect(302).expect('location', '/configure');
    await request(app).get('/assets/configure.js').expect(200);
  });

  it('API de opciones, validación y estado', async () => {
    const { app } = await server();
    const opts = (await request(app).get('/api/options').expect(200)).body;
    expect(opts.regions[0].code).toBe('ES');
    expect(opts.regions[0].platforms.map((p: { key: string }) => p.key)).toEqual(['netflix', 'disney', 'appletv', 'movistar']);
    const v = (await request(app).post('/api/config').send({ platforms: ['netflix'], types: ['movie', 'series'], region: 'ES', language: 'es-ES', sort: 'rating', layout: 'platform' }).expect(200)).body;
    expect(v.catalogs).toBe(2);
    expect(v.path).toMatch(/^\/[A-Za-z0-9_-]+\/manifest\.json$/);
    const st = (await request(app).get('/api/status').expect(200)).body;
    expect(st.lastUpdate).toBeTypeOf('number');
    const nf = st.regions[0].catalogs.find((c: { platform: string; type: string }) => c.platform === 'netflix' && c.type === 'movie');
    expect(nf).toMatchObject({ visible: 120, active: 120, lastFullComplete: true });
  });

  it('health check', async () => {
    const { app } = await server();
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok', syncing: false });
  });

  it('health degradado sin sincronizaciones, pero el servicio sigue respondiendo', async () => {
    const env = makeEnv();
    const { app } = createApp({ store: env.store, platforms: PLATFORMS, limits: env.limits });
    expect((await request(app).get('/health').expect(200)).body.status).toBe('degraded');
    expect((await request(app).get('/catalog/movie/netflix.movie.json').expect(200)).body.metas).toEqual([]);
  });

  it('nunca expone el token de TMDB', async () => {
    process.env.TMDB_ACCESS_TOKEN = SECRET;
    const { app } = await server();
    for (const url of ['/manifest.json', '/api/options', '/api/status', '/health', '/configure', '/catalog/movie/netflix.movie.json']) {
      const res = await request(app).get(url);
      expect(res.text).not.toContain(SECRET);
    }
    delete process.env.TMDB_ACCESS_TOKEN;
  });

  it('no existe ruta de streams', async () => {
    const { app } = await server();
    await request(app).get('/stream/movie/tt1000001.json').expect(404);
    await request(app).get('/meta/movie/tt1000001.json').expect(404);
  });
});
