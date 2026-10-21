import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addonBuilder } from 'stremio-addon-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { exportStaticSite } from '../../src/static/export.js';
import { makeEnv, PLATFORMS } from '../helpers/setup.js';

const root = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function exported(maxPages = 2) {
  const env = makeEnv();
  for (let i = 1; i <= 250; i++) env.fake.add({ type: 'movie', id: i, popularity: 1000 - i, genres: i <= 120 ? [878] : [18] });
  env.fake.add({ type: 'tv', id: 900, genres: [10765] });
  env.fake.add({ type: 'movie', id: 950, offers: { ES: { flatrate: [337] } } });
  await env.sync.run('full');
  // Nombres reales de TMDB para comprobar tildes y espacios en los nombres de archivo.
  env.store.replaceGenres('movie', 'es-ES', [{ id: 878, name: 'Ciencia ficción' }, { id: 18, name: 'Drama' }], env.now());
  env.store.bumpDataVersion();
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'shub-static-'));
  dirs.push(outDir);
  const report = exportStaticSite(env.store, PLATFORMS, {
    outDir,
    siteTemplateDir: path.join(root, 'public', 'static-site'),
    sharedCssFile: path.join(root, 'public', 'assets', 'configure.css'),
    region: 'ES',
    language: 'es-ES',
    sorts: ['popularity', 'rating'],
    maxPages,
    descriptionMax: 12,
    now: env.now,
  });
  const read = (rel: string) => JSON.parse(readFileSync(path.join(outDir, ...rel.split('/')), 'utf8'));
  return { env, outDir, report, read };
}

describe('sitio estático', () => {
  it('genera un addon válido por plataforma y orden', async () => {
    const { report, read } = await exported();
    // Netflix, Disney+, Apple TV+ y Movistar Plus+ están en la región simulada × 2 órdenes.
    expect(report.addons).toBe(8);
    const m = read('netflix/popularity/manifest.json');
    expect(m.id).toBe('org.streaminghub.netflix');
    expect(m.name).toBe('Streaming Hub · Netflix');
    expect(m.resources).toEqual(['catalog']);
    expect(m.catalogs.map((c: { id: string }) => c.id)).toEqual(['netflix.movie', 'netflix.series']);
    expect(() => new addonBuilder(m).defineCatalogHandler(async () => ({ metas: [] })).getInterface()).not.toThrow();
    expect(read('netflix/rating/manifest.json').id).toBe('org.streaminghub.netflix');
  });

  it('las rutas coinciden con las que pide Stremio (valores decodificados)', async () => {
    const { outDir, read } = await exported();
    const dir = 'netflix/popularity/catalog/movie';
    expect(read(`${dir}/netflix.movie.json`).metas).toHaveLength(100);
    expect(read(`${dir}/netflix.movie/skip=100.json`).metas).toHaveLength(100);
    // Stremio pide "genre=Ciencia%20ficci%C3%B3n"; el servidor estático lo decodifica a este nombre.
    const file = decodeURIComponent(`${dir}/netflix.movie/genre=${encodeURIComponent('Ciencia ficción')}.json`);
    expect(read(file).metas).toHaveLength(100);
    // Página siguiente de un género: stremio-core pone primero el skip.
    expect(read(`${dir}/netflix.movie/skip=100&genre=Ciencia ficción.json`).metas).toHaveLength(20);
    expect(existsSync(path.join(outDir, ...`${dir}/netflix.movie/genre=Ciencia ficción&skip=100.json`.split('/')))).toBe(false);
  });

  it('limita las páginas y cierra el catálogo con una página vacía', async () => {
    const { read, report, outDir } = await exported(2);
    const dir = 'netflix/popularity/catalog/movie/netflix.movie';
    expect(read(`${dir}/skip=100.json`).metas).toHaveLength(100);
    expect(read(`${dir}/skip=200.json`).metas).toEqual([]);
    expect(existsSync(path.join(outDir, ...`${dir}/skip=300.json`.split('/')))).toBe(false);
    expect(report.truncatedCatalogs).toBeGreaterThan(0);
  });

  it('vistas previas ligeras: sin fondo y con sinopsis recortada', async () => {
    const { read } = await exported();
    const meta = read('netflix/popularity/catalog/movie/netflix.movie.json').metas[0];
    expect(meta.background).toBeUndefined();
    expect(meta.description.length).toBeLessThanOrEqual(12);
    expect(meta.description.endsWith('…')).toBe(true);
    expect(meta.id).toMatch(/^tt\d{7,}$/);
  });

  it('incluye página de configuración, datos del sitio y redirección de «Configurar»', async () => {
    const { outDir, read } = await exported();
    const files = readdirSync(outDir);
    expect(files).toEqual(expect.arrayContaining(['index.html', 'site.json', '.nojekyll', 'assets']));
    expect(readdirSync(path.join(outDir, 'assets'))).toEqual(expect.arrayContaining(['configure.css', 'site.css', 'site.js']));
    const site = read('site.json');
    expect(site.platforms.map((p: { key: string }) => p.key)).toEqual(['netflix', 'disney']);
    expect(site.sorts.map((s: { code: string }) => s.code)).toEqual(['popularity', 'rating']);
    expect(site.maxTitlesPerCatalog).toBe(200);
    const redirect = readFileSync(path.join(outDir, 'netflix', 'rating', 'configure', 'index.html'), 'utf8');
    expect(redirect).toContain('../../../index.html?platform=netflix&amp;sort=rating'.replace('&amp;', '&'));
  });

  it('no publica el token de TMDB', async () => {
    process.env.TMDB_ACCESS_TOKEN = 'eyJ-token-secreto-de-prueba';
    const { outDir } = await exported();
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(outDir)) expect(readFileSync(f, 'utf8')).not.toContain('token-secreto');
    delete process.env.TMDB_ACCESS_TOKEN;
  });
});
