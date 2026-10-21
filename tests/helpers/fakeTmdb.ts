import { TmdbError } from '../../src/tmdb/client.js';
import type {
  DiscoverParams,
  TmdbApi,
  TmdbDiscoverItem,
  TmdbGenre,
  TmdbMediaType,
  TmdbPage,
  TmdbProvider,
  TmdbRegionOffers,
} from '../../src/tmdb/types.js';

export interface FakeTitle {
  type: TmdbMediaType;
  id: number;
  name: string;
  imdb: string | null;
  date: string | null;
  popularity: number;
  vote: number;
  votes: number;
  genres: number[];
  /** region → monetización → ID de proveedor */
  offers: Record<string, Partial<Record<'flatrate' | 'free' | 'ads' | 'rent' | 'buy', number[]>>>;
}

export const PROVIDERS: TmdbProvider[] = [
  { provider_id: 8, provider_name: 'Netflix', display_priorities: { ES: 0 } },
  { provider_id: 1796, provider_name: 'Netflix Standard with Ads', display_priorities: { ES: 50 } },
  { provider_id: 337, provider_name: 'Disney Plus', display_priorities: { ES: 3 } },
  { provider_id: 350, provider_name: 'Apple TV', display_priorities: { ES: 2 } },
  { provider_id: 2, provider_name: 'Apple TV Store', display_priorities: { ES: 6 } },
  { provider_id: 149, provider_name: 'Movistar Plus+ Ficción Total ', display_priorities: { ES: 7 } },
];

export const GENRES: Record<TmdbMediaType, TmdbGenre[]> = {
  movie: [
    { id: 28, name: 'Acción' },
    { id: 35, name: 'Comedia' },
    { id: 18, name: 'Drama' },
  ],
  tv: [
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 18, name: 'Drama' },
  ],
};

/** Doble de TMDB en memoria que reproduce paginación de 20, límite de páginas y filtros de Discover. */
export class FakeTmdb implements TmdbApi {
  titles: FakeTitle[] = [];
  providers: TmdbProvider[] = [...PROVIDERS];
  calls: Record<string, number> = {};
  /** Si devuelve un error, se lanza en lugar de responder. */
  failWith: ((method: string, arg?: unknown) => Error | null) | null = null;

  constructor(readonly maxPage = 500, readonly pageSize = 20) {}

  private hit(method: string, arg?: unknown): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    const err = this.failWith?.(method, arg);
    if (err) throw err;
  }

  add(t: Partial<FakeTitle> & Pick<FakeTitle, 'type' | 'id'>): FakeTitle {
    const full: FakeTitle = {
      name: `Título ${t.id}`,
      imdb: `tt${String(1000000 + t.id)}`,
      date: '2020-01-01',
      popularity: 10,
      vote: 7,
      votes: 500,
      genres: [18],
      offers: { ES: { flatrate: [8] } },
      ...t,
    };
    this.titles.push(full);
    return full;
  }

  remove(type: TmdbMediaType, id: number): void {
    this.titles = this.titles.filter((t) => !(t.type === type && t.id === id));
  }

  async watchProviders(_type: TmdbMediaType, _region: string): Promise<TmdbProvider[]> {
    this.hit('watchProviders');
    return this.providers;
  }

  async genres(type: TmdbMediaType): Promise<TmdbGenre[]> {
    this.hit('genres');
    return GENRES[type];
  }

  private matches(t: FakeTitle, type: TmdbMediaType, p: DiscoverParams): boolean {
    if (t.type !== type) return false;
    const offers = t.offers[p.region] ?? {};
    const offered = p.monetization.some((m) => (offers[m as keyof typeof offers] ?? []).some((id) => p.providers.includes(id)));
    if (!offered) return false;
    if (p.dateGte && (!t.date || t.date < p.dateGte)) return false;
    if (p.dateLte && (!t.date || t.date > p.dateLte)) return false;
    return true;
  }

  async discover(type: TmdbMediaType, p: DiscoverParams): Promise<TmdbPage<TmdbDiscoverItem>> {
    this.hit('discover', p);
    if (p.page < 1 || p.page > this.maxPage) throw new TmdbError(`Invalid page ${p.page}`, 400, false);
    const list = this.titles.filter((t) => this.matches(t, type, p));
    const [field, dir] = p.sortBy.split('.');
    const key = (t: FakeTitle): string | number => (field === 'popularity' ? t.popularity : t.date ?? '');
    list.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = ka < kb ? -1 : ka > kb ? 1 : a.id - b.id;
      return dir === 'desc' ? -c : c;
    });
    const total = list.length;
    const slice = list.slice((p.page - 1) * this.pageSize, p.page * this.pageSize);
    return {
      page: p.page,
      total_results: total,
      total_pages: Math.ceil(total / this.pageSize) || 0,
      results: slice.map((t) => ({
        id: t.id,
        ...(type === 'movie' ? { title: t.name, release_date: t.date ?? '' } : { name: t.name, first_air_date: t.date ?? '' }),
        overview: `Sinopsis de ${t.name}`,
        poster_path: `/p${t.id}.jpg`,
        backdrop_path: `/b${t.id}.jpg`,
        popularity: t.popularity,
        vote_average: t.vote,
        vote_count: t.votes,
        genre_ids: t.genres,
        original_language: 'en',
      })),
    };
  }

  async imdbId(type: TmdbMediaType, id: number): Promise<string | null> {
    this.hit('imdbId', id);
    const t = this.titles.find((x) => x.type === type && x.id === id);
    if (!t) throw new TmdbError('not found', 404, false);
    return t.imdb;
  }

  async titleOffers(type: TmdbMediaType, id: number): Promise<Record<string, TmdbRegionOffers>> {
    this.hit('titleOffers', id);
    const t = this.titles.find((x) => x.type === type && x.id === id);
    if (!t) throw new TmdbError('not found', 404, false);
    const out: Record<string, TmdbRegionOffers> = {};
    for (const [region, offers] of Object.entries(t.offers)) {
      out[region] = Object.fromEntries(Object.entries(offers).map(([m, ids]) => [m, ids.map((provider_id) => ({ provider_id }))]));
    }
    return out;
  }
}
