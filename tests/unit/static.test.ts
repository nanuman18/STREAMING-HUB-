import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addonBuilder } from 'stremio-addon-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { exportStaticSite } from '../../src/static/export.js';
import { makeEnv, PLATFORMS } from '../helpers/setup.js';

const root = path.resolve(import.meta.dirname, '../..');
const BASE = 'https://usuario.github.io/STREAMING-HUB-';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function exported(maxPages = 2) {
  const env = makeEnv();
  // 250 películas de Netflix con fechas distintas (la 1 es la más reciente).
  for (let i = 1; i <= 250; i++) {
    const d = new Date(Date.UTC(2026, 8, 30) - i * 86_400_000).toISOString().slice(0, 10);
    env.fake.add({ type: 'movie', id: i, popularity: i, date: d, genres: i <= 120 ? [878] : [18] });
  }
  env.fake.add({ type: 'movie', id: 400, date: '2099-01-01' }); // estreno futuro: no aparece por fecha
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
    baseUrl: BASE,
    region: 'ES',
    language: 'es-ES',
    maxPages,
    descriptionMax: 12,
    now: env.now,
  });
  const read = (rel: string) => JSON.parse(readFileSync(path.join(outDir, ...rel.split('/')), 'utf8'));
  const exists = (rel: string) => existsSync(path.join(outDir, ...rel.split('/')));
  return { env, outDir, report, read, exists };
}

describe('sitio estático (un addon con fila de plataformas)', () => {
  it('un único manifiesto válido: fila de plataformas + catálogos que no ocupan Inicio', async () => {
    const { report, read } = await exported();
    expect(report.platforms).toBe(2); // solo las plataformas con títulos (Netflix y Disney+)
    const m = read('manifest.json');
    expect(m.id).toBe('org.streaminghub.hub');
    expect(m.resources).toEqual(['catalog', { name: 'meta', types: ['other'], idPrefixes: ['shub-'] }]);
    expect(m.catalogs.map((c: { id: string; type: string }) => `${c.type}/${c.id}`)).toEqual([
      'other/plataformas', 'movie/netflix.movie', 'series/netflix.series', 'movie/disney.movie',
    ]);
    // La fila de plataformas no tiene extras: es la única que Stremio pinta en Inicio.
    expect(m.catalogs[0].extra).toBeUndefined();
    // El resto exige el filtro (primera opción «Todo»): Stremio no los pone en Inicio.
    expect(m.catalogs[1].extra[0]).toMatchObject({ name: 'genre', isRequired: true });
    expect(m.catalogs[1].extra[0].options[0]).toBe('Todo');
    expect(m.catalogs[1].extra[1]).toEqual({ name: 'skip' });
    expect(() => new addonBuilder(m).defineCatalogHandler(async () => ({ metas: [] })).defineMetaHandler(async () => ({ meta: null })).getInterface()).not.toThrow();
  });

  it('iconos de plataforma con el logo de TMDB', async () => {
    const { read } = await exported();
    const tiles = read('catalog/other/plataformas.json').metas;
    expect(tiles.map((t: { id: string }) => t.id)).toEqual(['shub-netflix', 'shub-disney']);
    expect(tiles[0]).toMatchObject({
      type: 'other', name: 'Netflix', posterShape: 'square',
      poster: 'https://image.tmdb.org/t/p/w500/netflix.png', // el de mayor prioridad, no el de «con anuncios»
    });
    expect(tiles[0].description).toMatch(/251 películas · 1 series/); // incluye el estreno futuro
    expect(tiles[1].poster).toBeUndefined(); // sin logo en TMDB: Stremio muestra el nombre
  });

  it('la ficha de cada plataforma enlaza a sus catálogos en Descubrir', async () => {
    const { read } = await exported();
    const meta = read('meta/other/shub-netflix.json').meta;
    expect(meta).toMatchObject({ id: 'shub-netflix', type: 'other', name: 'Netflix' });
    const manifest = encodeURIComponent(`${BASE}/manifest.json`);
    expect(meta.links).toEqual([
      { name: 'Películas de Netflix', category: 'Ver catálogo', url: `stremio:///discover/${manifest}/movie/netflix.movie?genre=Todo` },
      { name: 'Series de Netflix', category: 'Ver catálogo', url: `stremio:///discover/${manifest}/series/netflix.series?genre=Todo` },
    ]);
    // Disney+ solo tiene películas: un único enlace.
    expect(read('meta/other/shub-disney.json').meta.links).toHaveLength(1);
  });

  it('catálogos del estreno más reciente al más antiguo, sin estrenos futuros', async () => {
    const { read } = await exported();
    const metas = read('catalog/movie/netflix.movie/genre=Todo.json').metas;
    expect(metas).toHaveLength(100);
    expect(metas.map((m: { id: string }) => m.id).slice(0, 3)).toEqual(['tt1000001', 'tt1000002', 'tt1000003']);
    expect(metas.map((m: { id: string }) => m.id)).not.toContain('tt1000400');
  });

  it('rutas exactas que pide Stremio, con géneros con tildes y paginación', async () => {
    const { read, exists } = await exported();
    const dir = 'catalog/movie/netflix.movie';
    expect(read(`${dir}/skip=100&genre=Todo.json`).metas).toHaveLength(100);
    // Stremio pide "genre=Ciencia%20ficci%C3%B3n"; el servidor estático lo decodifica a este nombre.
    const file = decodeURIComponent(`${dir}/genre=${encodeURIComponent('Ciencia ficción')}.json`);
    expect(read(file).metas).toHaveLength(100);
    expect(read(`${dir}/skip=100&genre=Ciencia ficción.json`).metas).toHaveLength(20);
    // Sin filtro no existe: el catálogo exige «genre».
    expect(exists(`${dir}.json`)).toBe(false);
  });

  it('limita las páginas y cierra el catálogo con una página vacía', async () => {
    const { read, exists, report } = await exported(2);
    const dir = 'catalog/movie/netflix.movie';
    expect(read(`${dir}/skip=200&genre=Todo.json`).metas).toEqual([]);
    expect(exists(`${dir}/skip=300&genre=Todo.json`)).toBe(false);
    expect(report.truncatedCatalogs).toBeGreaterThan(0);
  });

  it('vistas previas ligeras con IMDb ID', async () => {
    const { read } = await exported();
    const meta = read('catalog/movie/netflix.movie/genre=Todo.json').metas[0];
    expect(meta.id).toMatch(/^tt\d{7,}$/);
    expect(meta.background).toBeUndefined();
    expect(meta.description.length).toBeLessThanOrEqual(12);
  });

  it('página de instalación, datos del sitio y redirección de «Configurar»', async () => {
    const { outDir, read } = await exported();
    expect(readdirSync(outDir)).toEqual(expect.arrayContaining(['index.html', 'site.json', '.nojekyll', 'assets', 'manifest.json']));
    const site = read('site.json');
    expect(site.manifestUrl).toBe(`${BASE}/manifest.json`);
    expect(site.platforms[0]).toEqual({ key: 'netflix', name: 'Netflix', logo: 'https://image.tmdb.org/t/p/w154/netflix.png' });
    expect(readFileSync(path.join(outDir, 'configure', 'index.html'), 'utf8')).toContain('url=../index.html');
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
