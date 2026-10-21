import { describe, expect, it } from 'vitest';
import { TmdbError } from '../../src/tmdb/client.js';
import { SyncBusyError } from '../../src/sync/service.js';
import { FakeTmdb } from '../helpers/fakeTmdb.js';
import { makeEnv } from '../helpers/setup.js';

const DAY = 86_400_000;

function seed(fake: FakeTmdb) {
  for (let i = 1; i <= 45; i++) fake.add({ type: 'movie', id: i, popularity: 100 - i });
  fake.add({ type: 'movie', id: 100, offers: { ES: { flatrate: [337] } } }); // solo Disney+
  fake.add({ type: 'movie', id: 101, imdb: null }); // Netflix sin IMDb
  fake.add({ type: 'tv', id: 500, genres: [10765] });
  fake.add({ type: 'tv', id: 501, offers: { ES: { ads: [1796] } } }); // Netflix con anuncios
  fake.add({ type: 'movie', id: 600, offers: { ES: { rent: [8] } } }); // solo alquiler: no cuenta
}

describe('sincronización', () => {
  it('resuelve los ID reales de proveedor por nombre (sin inventarlos)', async () => {
    const env = makeEnv();
    seed(env.fake);
    await env.sync.run('full');
    const map = env.store.platformProviders('ES');
    expect(map.get('netflix')?.ids).toEqual([8, 1796]);
    expect(map.get('disney')?.ids).toEqual([337]);
    // "Apple TV Store" (alquiler) no se confunde con Apple TV+.
    expect(map.get('appletv')?.ids).toEqual([350]);
    // El nombre con espacio final de TMDB se normaliza.
    expect(map.get('movistar')?.ids).toEqual([149]);
    // Plataformas que la región no lista no se resuelven.
    expect(map.has('filmin')).toBe(false);
  });

  it('recoge todas las páginas, filtra por proveedor y monetización y resuelve IMDb', async () => {
    const env = makeEnv();
    seed(env.fake);
    const report = await env.sync.run('full');
    expect(report.status).toBe('ok');
    const nfMovies = report.catalogs.find((c) => c.platform === 'netflix' && c.type === 'movie')!;
    expect(nfMovies.collected).toBe(46); // 45 + el título sin IMDb
    expect(nfMovies.complete).toBe(true);
    expect(nfMovies.pagesFetched).toBe(3);
    expect(env.store.countActive('ES', 'netflix', 'tv')).toBe(2);
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 600)).toBeUndefined();
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 100)).toBeUndefined();
    expect(env.store.countActive('ES', 'disney', 'movie')).toBe(1);
    expect(report.imdb.found).toBe(48);
    expect(report.imdb.missing).toBe(1);
    expect(env.store.getTitle('movie', 101)?.imdb_status).toBe('missing');
  });

  it('la carga inicial no genera novedades; lo que aparece después sí', async () => {
    const env = makeEnv();
    seed(env.fake);
    const first = await env.sync.run('full');
    expect(first.catalogs.reduce((a, c) => a + c.added, 0)).toBe(0);
    env.advance(DAY);
    env.fake.add({ type: 'movie', id: 900, popularity: 1 });
    const second = await env.sync.run('incremental');
    expect(second.catalogs.find((c) => c.platform === 'netflix' && c.type === 'movie')!.added).toBe(1);
    const av = env.store.availabilityOf('ES', 'netflix', 'movie', 900)!;
    expect(av.baseline).toBe(0);
    const events = env.store.db.prepare(`SELECT event FROM title_events WHERE tmdb_id = 900`).all();
    expect(events).toEqual([{ event: 'added' }]);
  });

  it('detecta retiradas solo tras verificar el título individualmente', async () => {
    const env = makeEnv();
    seed(env.fake);
    await env.sync.run('full');
    env.advance(DAY);
    // 1) Retirado de verdad: ya no tiene oferta en Netflix.
    env.fake.titles.find((t) => t.id === 3)!.offers = { ES: { flatrate: [337] } };
    // 2) Discover lo omite pero su ficha dice que sigue en Netflix (respuesta parcial): NO es retirada.
    const ghost = env.fake.titles.find((t) => t.id === 4)!;
    const realMatches = env.fake['matches'].bind(env.fake);
    env.fake['matches'] = (t, type, p) => (t.id === 4 ? false : realMatches(t, type, p));
    const report = await env.sync.run('full');
    const nf = report.catalogs.find((c) => c.platform === 'netflix' && c.type === 'movie')!;
    expect(nf.removalCandidates).toBe(2);
    expect(nf.removed).toBe(1);
    expect(nf.confirmedPresent).toBe(1);
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 3)?.status).toBe('removed');
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', ghost.id)?.status).toBe('active');
    // Aparece en Disney+ como novedad.
    expect(env.store.availabilityOf('ES', 'disney', 'movie', 3)?.status).toBe('active');
  });

  it('un título borrado de TMDB (404) se da de baja', async () => {
    const env = makeEnv();
    seed(env.fake);
    await env.sync.run('full');
    env.advance(DAY);
    env.fake.remove('movie', 7);
    const report = await env.sync.run('full');
    expect(report.catalogs.find((c) => c.platform === 'netflix' && c.type === 'movie')!.removed).toBe(1);
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 7)?.status).toBe('removed');
  });

  it('un título retirado que vuelve se reactiva como novedad', async () => {
    const env = makeEnv();
    seed(env.fake);
    await env.sync.run('full');
    const t = env.fake.titles.find((x) => x.id === 5)!;
    t.offers = {};
    env.advance(DAY);
    await env.sync.run('full');
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 5)?.status).toBe('removed');
    t.offers = { ES: { flatrate: [8] } };
    env.advance(DAY);
    const r = await env.sync.run('incremental');
    expect(r.catalogs.find((c) => c.platform === 'netflix' && c.type === 'movie')!.readded).toBe(1);
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 5)?.status).toBe('active');
  });

  it('la sincronización incremental nunca da de baja títulos', async () => {
    const env = makeEnv({ incrementalPages: 1 });
    seed(env.fake);
    await env.sync.run('full');
    env.advance(DAY);
    env.fake.remove('movie', 44);
    await env.sync.run('incremental');
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 44)?.status).toBe('active');
    expect(env.fake.calls.titleOffers ?? 0).toBe(0);
  });

  it('si falla alguna página no se evalúan retiradas y se conserva el catálogo', async () => {
    const env = makeEnv();
    seed(env.fake);
    await env.sync.run('full');
    env.advance(DAY);
    env.fake.remove('movie', 1);
    env.fake.failWith = (method, arg) =>
      method === 'discover' && (arg as { page: number; providers: number[] }).page === 2 && (arg as { providers: number[] }).providers.includes(8)
        ? new TmdbError('TMDB caído', 503, true)
        : null;
    const report = await env.sync.run('full');
    const nf = report.catalogs.find((c) => c.platform === 'netflix' && c.type === 'movie')!;
    expect(report.status).toBe('partial');
    expect(nf.complete).toBe(false);
    expect(nf.removed).toBe(0);
    expect(env.store.availabilityOf('ES', 'netflix', 'movie', 1)?.status).toBe('active');
    expect(env.store.harvestStatus('ES').find((h) => h.platform === 'netflix' && h.media_type === 'movie')?.last_error).toMatch(/TMDB caído/);
  });

  it('si TMDB no responde, conserva los datos y usa la última resolución de proveedores', async () => {
    const env = makeEnv();
    seed(env.fake);
    await env.sync.run('full');
    const before = env.store.countActive('ES', 'netflix', 'movie');
    env.advance(DAY);
    env.fake.failWith = () => new TmdbError('sin conexión', null, true);
    const report = await env.sync.run('full');
    expect(report.status).toBe('failed');
    expect(env.store.countActive('ES', 'netflix', 'movie')).toBe(before);
    expect(env.store.platformProviders('ES').get('netflix')?.ids).toEqual([8, 1796]);
  });

  it('impide dos sincronizaciones simultáneas (en proceso y entre procesos)', async () => {
    const env = makeEnv();
    seed(env.fake);
    const first = env.sync.run('full');
    await expect(env.sync.run('incremental')).rejects.toBeInstanceOf(SyncBusyError);
    await first;
    // Otro proceso con la misma BD tiene el bloqueo.
    expect(env.store.acquireLock('sync', 'otro-proceso', 60_000, env.now())).toBe(true);
    await expect(env.sync.run('incremental')).rejects.toBeInstanceOf(SyncBusyError);
    env.store.releaseLock('sync', 'otro-proceso');
    await expect(env.sync.run('incremental')).resolves.toBeTruthy();
  });

  it('particiona por fechas cuando la consulta supera el máximo de páginas', async () => {
    const fake = new FakeTmdb(3); // la API simulada solo admite 3 páginas (60 resultados)
    const env = makeEnv({ apiMaxPage: 3 }, fake);
    for (let i = 1; i <= 130; i++) {
      const year = 1990 + (i % 30);
      fake.add({ type: 'movie', id: i, date: `${year}-0${1 + (i % 9)}-1${i % 10}` });
    }
    fake.add({ type: 'movie', id: 999, date: null }); // sin fecha: inalcanzable con filtro de fechas
    const report = await env.sync.run('full');
    const nf = report.catalogs.find((c) => c.platform === 'netflix' && c.type === 'movie')!;
    expect(nf.partitioned).toBe(true);
    expect(nf.totalResults).toBe(131);
    expect(nf.collected).toBe(130);
    expect(nf.complete).toBe(true);
    expect(nf.notes.join(' ')).toMatch(/sin fecha/);
  });

  it('reintenta más tarde los títulos sin IMDb ID', async () => {
    const env = makeEnv({ imdbRetryDays: 3 });
    seed(env.fake);
    await env.sync.run('full');
    const t = env.fake.titles.find((x) => x.id === 101)!;
    t.imdb = 'tt7654321';
    env.advance(DAY);
    await env.sync.run('incremental');
    expect(env.store.getTitle('movie', 101)?.imdb_id).toBeNull();
    env.advance(3 * DAY);
    await env.sync.run('incremental');
    expect(env.store.getTitle('movie', 101)?.imdb_id).toBe('tt7654321');
  });
});
