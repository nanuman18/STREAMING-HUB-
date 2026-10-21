import { describe, expect, it, vi } from 'vitest';
import { normalizeImdbId, TmdbClient, TmdbError } from '../../src/tmdb/client.js';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof TmdbClient>[0]> = {}) {
  return new TmdbClient({ accessToken: 'TOKEN-SECRETO', fetchImpl, maxRps: 1000, sleep: async () => {}, backoffBaseMs: 1, ...extra });
}

describe('cliente TMDB', () => {
  it('autentica con Bearer y construye la consulta de Discover', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response(200, { page: 1, results: [], total_pages: 0, total_results: 0 }));
    const c = client(fetchImpl as unknown as typeof fetch);
    await c.discover('movie', { region: 'ES', language: 'es-ES', providers: [8, 1796], monetization: ['flatrate', 'ads'], sortBy: 'popularity.desc', page: 3, dateGte: '2020-01-01' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe('/3/discover/movie');
    expect(u.searchParams.get('with_watch_providers')).toBe('8|1796');
    expect(u.searchParams.get('with_watch_monetization_types')).toBe('flatrate|ads');
    expect(u.searchParams.get('watch_region')).toBe('ES');
    expect(u.searchParams.get('primary_release_date.gte')).toBe('2020-01-01');
    expect(u.searchParams.get('page')).toBe('3');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer TOKEN-SECRETO');
  });

  it('reintenta 429 respetando Retry-After y errores 5xx con backoff', async () => {
    const replies = [response(429, 'slow down', { 'retry-after': '1' }), response(502, 'bad gateway'), response(200, { imdb_id: 'tt0903747' })];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const sleeps: number[] = [];
    const c = client(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(await c.imdbId('tv', 1396)).toBe('tt0903747');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it('reintenta errores de red y se rinde tras maxRetries', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const c = client(fetchImpl as unknown as typeof fetch, { maxRetries: 2 });
    await expect(c.genres('movie', 'es-ES')).rejects.toMatchObject({ name: 'TmdbError', status: null, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('no reintenta 401/404 y no filtra la clave en los errores', async () => {
    const fetchImpl = vi.fn(async () => response(404, { status_message: 'not found' }));
    const c = new TmdbClient({ apiKey: 'CLAVE-V3', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    const err = await c.imdbId('movie', 1).catch((e) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect(err.status).toBe(404);
    expect(err.message).not.toContain('CLAVE-V3');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('valida el formato de IMDb ID (nunca fabrica uno)', () => {
    expect(normalizeImdbId('tt0903747')).toBe('tt0903747');
    expect(normalizeImdbId(' tt12345678 ')).toBe('tt12345678');
    expect(normalizeImdbId('')).toBeNull();
    expect(normalizeImdbId(null)).toBeNull();
    expect(normalizeImdbId('tt123')).toBeNull();
    expect(normalizeImdbId('nm0000001')).toBeNull();
  });
});
