import { addonBuilder } from 'stremio-addon-sdk';
import { describe, expect, it } from 'vitest';
import { ADDON_ID, MANIFEST_BUDGET } from '../../src/addon/addon.js';
import { defaultConfig } from '../../src/addon/userConfig.js';
import { GENRES, PROVIDERS } from '../helpers/fakeTmdb.js';
import { makeEnv, PLATFORMS } from '../helpers/setup.js';

describe('manifiesto', () => {
  it('es válido para el SDK oficial y solo declara catálogos (sin streams ni meta)', async () => {
    const env = makeEnv();
    env.fake.add({ type: 'movie', id: 1 });
    await env.sync.run('full');
    const { iface } = env.addon.getInterface(defaultConfig(env.limits));
    const m = iface.manifest;
    expect(m.id).toBe(ADDON_ID);
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.resources).toEqual(['catalog']);
    expect(m.types).toEqual(['movie', 'series']);
    expect(m.behaviorHints).toMatchObject({ configurable: true, configurationRequired: false });
    // El SDK valida al construir; volver a construir no debe lanzar.
    expect(() => new addonBuilder(JSON.parse(JSON.stringify(m))).defineCatalogHandler(async () => ({ metas: [] })).getInterface()).not.toThrow();
    expect(m.resources).not.toContain('stream');
    expect(m.resources).not.toContain('meta');
    expect(m.idPrefixes).toBeUndefined();
  });

  it('un catálogo por plataforma y tipo, con nombre, géneros y paginación', async () => {
    const env = makeEnv();
    env.fake.add({ type: 'movie', id: 1, genres: [28, 35] });
    env.fake.add({ type: 'tv', id: 2, genres: [10765] });
    await env.sync.run('full');
    const m = env.addon.buildManifest(defaultConfig(env.limits)).manifest;
    // En la región simulada solo existen Netflix, Disney+, Apple TV+ y Movistar Plus+.
    expect(m.catalogs.map((c) => c.id)).toEqual([
      'netflix.movie', 'netflix.series', 'disney.movie', 'disney.series',
      'appletv.movie', 'appletv.series', 'movistar.movie', 'movistar.series',
    ]);
    const nf = m.catalogs[0]!;
    expect(nf).toMatchObject({ type: 'movie', name: 'Netflix — Películas' });
    expect(nf.extra).toEqual([
      { name: 'genre', options: ['Acción', 'Comedia'] },
      { name: 'skip' },
    ]);
    expect(m.catalogs[1]!.extra?.[0]?.options).toEqual(['Ciencia ficción y fantasía']);
    // Catálogo vacío: sin selector de géneros, pero paginable.
    expect(m.catalogs[2]!.extra).toEqual([{ name: 'skip' }]);
  });

  it('respeta la selección, el orden de plataformas y la agrupación por tipo', async () => {
    const env = makeEnv();
    env.fake.add({ type: 'movie', id: 1 });
    await env.sync.run('full');
    const base = defaultConfig(env.limits);
    const m1 = env.addon.buildManifest({ ...base, platforms: ['disney', 'netflix'], types: ['series'] }).manifest;
    expect(m1.catalogs.map((c) => c.id)).toEqual(['disney.series', 'netflix.series']);
    expect(m1.types).toEqual(['series']);
    const m2 = env.addon.buildManifest({ ...base, platforms: ['netflix', 'disney'], layout: 'type' }).manifest;
    expect(m2.catalogs.map((c) => c.id)).toEqual(['netflix.movie', 'disney.movie', 'netflix.series', 'disney.series']);
  });

  it('con las 12 plataformas y todos los géneros no supera 8 KB', async () => {
    const env = makeEnv();
    // Todos los proveedores reales que usa platforms.json, con títulos de todos los géneros.
    env.fake.providers = [
      ...PROVIDERS,
      ...['Amazon Prime Video', 'HBO Max', 'SkyShowtime', 'Filmin', 'Atres Player', 'rtve', 'Crunchyroll', 'Rakuten TV']
        .map((provider_name, i) => ({ provider_id: 9000 + i, provider_name })),
    ];
    // Géneros reales de TMDB en es-ES (respuesta de /genre/{type}/list consultada al desarrollar).
    const movieGenres = [[28, 'Acción'], [12, 'Aventura'], [16, 'Animación'], [35, 'Comedia'], [80, 'Crimen'], [99, 'Documental'], [18, 'Drama'], [10751, 'Familia'], [14, 'Fantasía'], [36, 'Historia'], [27, 'Terror'], [10402, 'Música'], [9648, 'Misterio'], [10749, 'Romance'], [878, 'Ciencia ficción'], [10770, 'Película de TV'], [53, 'Suspense'], [10752, 'Bélica'], [37, 'Western']] as const;
    const tvGenres = [[10759, 'Action & Adventure'], [16, 'Animación'], [35, 'Comedia'], [80, 'Crimen'], [99, 'Documental'], [18, 'Drama'], [10751, 'Familia'], [10762, 'Kids'], [9648, 'Misterio'], [10763, 'News'], [10764, 'Reality'], [10765, 'Sci-Fi & Fantasy'], [10766, 'Soap'], [10767, 'Talk'], [10768, 'War & Politics'], [37, 'Western']] as const;
    const savedMovie = GENRES.movie.splice(0, Infinity, ...movieGenres.map(([id, name]) => ({ id, name })));
    const savedTv = GENRES.tv.splice(0, Infinity, ...tvGenres.map(([id, name]) => ({ id, name })));
    const allIds = env.fake.providers.map((p) => p.provider_id);
    env.fake.add({ type: 'movie', id: 1, genres: movieGenres.map(([id]) => id), offers: { ES: { flatrate: allIds } } });
    env.fake.add({ type: 'tv', id: 2, genres: tvGenres.map(([id]) => id), offers: { ES: { flatrate: allIds } } });
    await env.sync.run('full');
    const { manifest, warnings } = env.addon.buildManifest(defaultConfig(env.limits));
    expect(manifest.catalogs).toHaveLength(PLATFORMS.length * 2);
    expect(JSON.stringify(manifest).length).toBeLessThanOrEqual(MANIFEST_BUDGET);
    // Si hubo que recortar géneros, se avisa.
    const longest = Math.max(...manifest.catalogs.map((c) => c.extra?.find((e) => e.name === 'genre')?.options?.length ?? 0));
    if (longest < movieGenres.length) expect(warnings.length).toBe(1);
    else expect(warnings).toEqual([]);
    GENRES.movie.splice(0, Infinity, ...savedMovie);
    GENRES.tv.splice(0, Infinity, ...savedTv);
  });
});
