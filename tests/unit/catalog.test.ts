import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, type UserConfig } from '../../src/addon/userConfig.js';
import { makeEnv } from '../helpers/setup.js';

const DAY = 86_400_000;

async function seeded() {
  const env = makeEnv();
  const f = env.fake;
  // 230 películas de Netflix con popularidad decreciente.
  for (let i = 1; i <= 230; i++) {
    f.add({ type: 'movie', id: i, popularity: 1000 - i, genres: i % 2 ? [28] : [35], date: `20${String(10 + (i % 15)).padStart(2, '0')}-05-01`, vote: (i % 10) + 0.5, votes: i % 3 ? 500 : 5 });
  }
  f.add({ type: 'movie', id: 300, imdb: null, popularity: 5000 }); // muy popular pero sin IMDb
  f.add({ type: 'movie', id: 301, popularity: 4000, date: '2099-01-01' }); // estreno futuro
  f.add({ type: 'movie', id: 400, popularity: 3000, offers: { ES: { flatrate: [337] } } }); // solo Disney+
  f.add({ type: 'tv', id: 500, popularity: 50, genres: [10765] });
  f.add({ type: 'tv', id: 501, popularity: 40, genres: [18] });
  // Dos fichas de TMDB con el mismo IMDb ID: se muestra solo una.
  f.add({ type: 'tv', id: 502, popularity: 30, imdb: 'tt0999999' });
  f.add({ type: 'tv', id: 503, popularity: 20, imdb: 'tt0999999' });
  await env.sync.run('full');
  return env;
}

function cfg(env: Awaited<ReturnType<typeof seeded>>, over: Partial<UserConfig> = {}): UserConfig {
  return { ...defaultConfig(env.limits), ...over };
}

describe('catálogos', () => {
  it('películas: solo IMDb ID válidos, ordenados por popularidad', async () => {
    const env = await seeded();
    const { metas } = env.addon.catalog(cfg(env), 'movie', 'netflix.movie');
    expect(metas).toHaveLength(100);
    expect(metas.every((m) => /^tt\d{7,}$/.test(m.id))).toBe(true);
    expect(metas.every((m) => m.type === 'movie')).toBe(true);
    // El título sin IMDb (el más popular) NO aparece; el estreno futuro sí (orden por popularidad).
    expect(metas[0]!.id).toBe('tt1000301');
    expect(metas.map((m) => m.id)).not.toContain('tt1000300');
    expect(metas[1]!).toMatchObject({ id: 'tt1000001', name: 'Título 1', posterShape: 'poster', releaseInfo: '2011' });
    expect(metas[1]!.poster).toBe('https://image.tmdb.org/t/p/w342/p1.jpg');
    expect(metas[1]!.genres).toEqual(['Acción']);
  });

  it('series: tipo series, géneros traducidos y sin duplicados por IMDb', async () => {
    const env = await seeded();
    const { metas } = env.addon.catalog(cfg(env), 'series', 'netflix.series');
    expect(metas.map((m) => m.id)).toEqual(['tt1000500', 'tt1000501', 'tt0999999']);
    expect(metas.every((m) => m.type === 'series')).toBe(true);
    expect(metas[0]!.genres).toEqual(['Ciencia ficción y fantasía']);
  });

  it('paginación con skip: páginas de 100, sin solapes, y final con menos de 100', async () => {
    const env = await seeded();
    const c = cfg(env);
    const p1 = env.addon.catalog(c, 'movie', 'netflix.movie', {}).metas;
    const p2 = env.addon.catalog(c, 'movie', 'netflix.movie', { skip: '100' }).metas;
    const p3 = env.addon.catalog(c, 'movie', 'netflix.movie', { skip: '200' }).metas;
    const p4 = env.addon.catalog(c, 'movie', 'netflix.movie', { skip: '300' }).metas;
    expect([p1.length, p2.length, p3.length, p4.length]).toEqual([100, 100, 31, 0]);
    const all = [...p1, ...p2, ...p3].map((m) => m.id);
    expect(new Set(all).size).toBe(231);
    // skip inválido equivale a 0
    expect(env.addon.catalog(c, 'movie', 'netflix.movie', { skip: 'abc' }).metas[0]!.id).toBe(p1[0]!.id);
  });

  it('filtro por proveedor: cada plataforma solo muestra lo suyo', async () => {
    const env = await seeded();
    const disney = env.addon.catalog(cfg(env), 'movie', 'disney.movie').metas.map((m) => m.id);
    expect(disney).toEqual(['tt1000400']);
    const netflix = env.addon.catalog(cfg(env), 'movie', 'netflix.movie', { skip: '0' }).metas.map((m) => m.id);
    expect(netflix).not.toContain('tt1000400');
  });

  it('filtro por género (nombre en español y nombre original de TMDB)', async () => {
    const env = await seeded();
    const action = env.addon.catalog(cfg(env), 'movie', 'netflix.movie', { genre: 'Acción' }).metas;
    expect(action.length).toBe(100);
    expect(action.every((m) => m.genres?.includes('Acción'))).toBe(true);
    const comedy = env.addon.catalog(cfg(env), 'movie', 'netflix.movie', { genre: 'comedia', skip: '100' }).metas;
    expect(comedy.every((m) => m.genres?.includes('Comedia'))).toBe(true);
    const scifi = env.addon.catalog(cfg(env), 'series', 'netflix.series', { genre: 'Sci-Fi & Fantasy' }).metas;
    expect(scifi.map((m) => m.id)).toEqual(['tt1000500']);
    expect(env.addon.catalog(cfg(env), 'movie', 'netflix.movie', { genre: 'Inexistente' }).metas).toEqual([]);
  });

  it('ordenaciones: estreno (sin futuros), valoración (con mínimo de votos) y novedades', async () => {
    const env = await seeded();
    const release = env.addon.catalog(cfg(env, { sort: 'release' }), 'movie', 'netflix.movie').metas;
    expect(release.map((m) => m.id)).not.toContain('tt1000301');
    expect(Number(release[0]!.releaseInfo)).toBeGreaterThanOrEqual(Number(release.at(-1)!.releaseInfo));

    const rating = env.addon.catalog(cfg(env, { sort: 'rating' }), 'movie', 'netflix.movie').metas;
    expect(rating.length).toBeGreaterThan(0);
    // Títulos con 5 votos (id múltiplo de 3) quedan fuera.
    const idx = (id: string) => Number(id.slice(2)) - 1000000;
    expect(rating.some((m) => idx(m.id) <= 230 && idx(m.id) % 3 === 0)).toBe(false);
    expect(rating[0]!.id).not.toBe(rating.at(-1)!.id);

    env.advance(DAY);
    // Título antiguo y poco popular: la incremental (primeras páginas) no lo ve; la revisión completa diaria sí.
    env.fake.add({ type: 'movie', id: 777, popularity: 0.1 });
    await env.sync.run('incremental');
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 777)).toBeUndefined();
    await env.sync.run('full');
    const fresh = env.addon.catalog(cfg(env, { sort: 'new' }), 'movie', 'netflix.movie').metas;
    expect(fresh[0]!.id).toBe('tt1000777');
  });

  it('catálogos no configurados o inexistentes devuelven lista vacía', async () => {
    const env = await seeded();
    const c = cfg(env, { platforms: ['disney'] });
    expect(env.addon.catalog(c, 'movie', 'netflix.movie').metas).toEqual([]);
    expect(env.addon.catalog(cfg(env, { types: ['series'] }), 'movie', 'netflix.movie').metas).toEqual([]);
    expect(env.addon.catalog(cfg(env), 'movie', 'netflix.series').metas).toEqual([]);
    expect(env.addon.catalog(cfg(env), 'movie', 'nada').metas).toEqual([]);
  });

  it('respuesta con cabeceras de caché', async () => {
    const env = await seeded();
    const r = env.addon.catalog(cfg(env), 'movie', 'netflix.movie');
    expect(r).toMatchObject({ cacheMaxAge: 3600, staleRevalidate: 21600, staleError: 604800 });
  });
});

describe('caché de catálogo', () => {
  it('reutiliza la consulta y se invalida tras una sincronización', async () => {
    const env = await seeded();
    const spy = vi.spyOn(env.store, 'listCatalog');
    const c = cfg(env);
    env.addon.catalog(c, 'movie', 'netflix.movie');
    env.addon.catalog(c, 'movie', 'netflix.movie');
    expect(spy).toHaveBeenCalledTimes(1);
    env.addon.catalog(c, 'movie', 'netflix.movie', { skip: '100' });
    expect(spy).toHaveBeenCalledTimes(2);
    await env.sync.run('incremental');
    env.addon.catalog(c, 'movie', 'netflix.movie');
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
