import { RateLimiter } from '../util/rateLimiter.js';
import { createLogger } from '../util/logger.js';
import type {
  DiscoverParams,
  TmdbApi,
  TmdbDiscoverItem,
  TmdbGenre,
  TmdbMediaType,
  TmdbPage,
  TmdbProvider,
  TmdbRegionOffers,
} from './types.js';

const log = createLogger('tmdb');

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TmdbError';
  }
}

export interface TmdbClientOptions {
  accessToken?: string | null;
  apiKey?: string | null;
  baseUrl?: string;
  maxRps?: number;
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Base del backoff exponencial (ms). */
  backoffBaseMs?: number;
}

export class TmdbClient implements TmdbApi {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly backoffBaseMs: number;
  /** Contador de peticiones HTTP realizadas (incluye reintentos). */
  requests = 0;

  constructor(private readonly opts: TmdbClientOptions) {
    if (!opts.accessToken && !opts.apiKey) throw new Error('TmdbClient: falta accessToken o apiKey');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = new RateLimiter(opts.maxRps ?? 20, opts.concurrency ?? 6, Date.now, this.sleep);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.themoviedb.org/3').replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
  }

  async get<T>(pathname: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + pathname);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.opts.accessToken) headers.authorization = `Bearer ${this.opts.accessToken}`;
    else if (this.opts.apiKey) url.searchParams.set('api_key', this.opts.apiKey);
    // La clave nunca se escribe en los registros.
    const safeUrl = pathname + (url.search ? url.search.replace(/api_key=[^&]+/, 'api_key=***') : '');

    let attempt = 0;
    for (;;) {
      try {
        return await this.limiter.run(() => this.once<T>(url, headers, safeUrl));
      } catch (err) {
        const e = err instanceof TmdbError ? err : new TmdbError(String((err as Error)?.message ?? err), null, true);
        if (!e.retryable || attempt >= this.maxRetries) throw e;
        const backoff = Math.min(30_000, this.backoffBaseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt++;
        log.warn('Reintentando petición a TMDB', { url: safeUrl, status: e.status, attempt, waitMs: Math.round(backoff) });
        await this.sleep(backoff);
      }
    }
  }

  private async once<T>(url: URL, headers: Record<string, string>, safeUrl: string): Promise<T> {
    this.requests++;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new TmdbError(`Error de red con TMDB (${safeUrl}): ${(err as Error).message}`, null, true);
    }
    if (res.ok) return (await res.json()) as T;

    let body = '';
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* cuerpo ilegible */
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      this.limiter.pause(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000);
    }
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new TmdbError(`TMDB respondió ${res.status} en ${safeUrl}: ${body}`, res.status, retryable);
  }

  async watchProviders(type: TmdbMediaType, region: string, language: string): Promise<TmdbProvider[]> {
    const j = await this.get<{ results: TmdbProvider[] }>(`/watch/providers/${type}`, { watch_region: region, language });
    return j.results ?? [];
  }

  async genres(type: TmdbMediaType, language: string): Promise<TmdbGenre[]> {
    const j = await this.get<{ genres: TmdbGenre[] }>(`/genre/${type}/list`, { language });
    return j.genres ?? [];
  }

  async discover(type: TmdbMediaType, p: DiscoverParams): Promise<TmdbPage<TmdbDiscoverItem>> {
    const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    return this.get<TmdbPage<TmdbDiscoverItem>>(`/discover/${type}`, {
      watch_region: p.region,
      with_watch_providers: p.providers.join('|'),
      with_watch_monetization_types: p.monetization.join('|'),
      language: p.language,
      sort_by: p.sortBy,
      page: p.page,
      include_adult: 'false',
      [`${dateField}.gte`]: p.dateGte,
      [`${dateField}.lte`]: p.dateLte,
    });
  }

  async imdbId(type: TmdbMediaType, tmdbId: number): Promise<string | null> {
    const j = await this.get<{ imdb_id?: string | null }>(`/${type}/${tmdbId}/external_ids`);
    return normalizeImdbId(j.imdb_id);
  }

  async titleOffers(type: TmdbMediaType, tmdbId: number): Promise<Record<string, TmdbRegionOffers>> {
    const j = await this.get<{ results?: Record<string, TmdbRegionOffers> }>(`/${type}/${tmdbId}/watch/providers`);
    return j.results ?? {};
  }
}

/** Acepta solo IMDb ID con formato real (tt + 7 o más dígitos). Nunca se fabrican. */
export function normalizeImdbId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return /^tt\d{7,}$/.test(v) ? v : null;
}
