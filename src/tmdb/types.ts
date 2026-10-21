export type TmdbMediaType = 'movie' | 'tv';

export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priorities?: Record<string, number>;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

/** Elemento devuelto por /discover/movie o /discover/tv (campos comunes normalizados). */
export interface TmdbDiscoverItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  popularity?: number;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  original_language?: string;
  adult?: boolean;
}

export interface TmdbPage<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

export interface DiscoverParams {
  region: string;
  language: string;
  /** ID de proveedor unidos con "|" (OR). */
  providers: number[];
  monetization: string[];
  sortBy: string;
  page: number;
  /** Rango de fechas (YYYY-MM-DD) sobre primary_release_date (películas) o first_air_date (series). */
  dateGte?: string;
  dateLte?: string;
}

export interface TmdbOffer {
  provider_id: number;
  provider_name?: string;
}

export interface TmdbRegionOffers {
  flatrate?: TmdbOffer[];
  free?: TmdbOffer[];
  ads?: TmdbOffer[];
  rent?: TmdbOffer[];
  buy?: TmdbOffer[];
}

/** Interfaz que usa el resto del addon; permite sustituir TMDB por un doble en las pruebas. */
export interface TmdbApi {
  watchProviders(type: TmdbMediaType, region: string, language: string): Promise<TmdbProvider[]>;
  genres(type: TmdbMediaType, language: string): Promise<TmdbGenre[]>;
  discover(type: TmdbMediaType, params: DiscoverParams): Promise<TmdbPage<TmdbDiscoverItem>>;
  /** Devuelve el IMDb ID o null. Lanza TmdbError(404) si el título ya no existe en TMDB. */
  imdbId(type: TmdbMediaType, tmdbId: number): Promise<string | null>;
  /** Ofertas por región del título (endpoint /{type}/{id}/watch/providers). */
  titleOffers(type: TmdbMediaType, tmdbId: number): Promise<Record<string, TmdbRegionOffers>>;
}

/** TMDB limita la paginación de /discover a 500 páginas (10.000 resultados). */
export const TMDB_MAX_PAGE = 500;
