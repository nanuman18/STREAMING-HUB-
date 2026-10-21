import type { Store } from '../db/store.js';
import type { TmdbMediaType } from '../tmdb/types.js';

/**
 * TMDB no traduce algunos géneros de series al español (devuelve "Sci-Fi & Fantasy", "Kids"...).
 * Se sustituyen solo para idiomas españoles; el ID de TMDB sigue siendo la referencia.
 */
const SPANISH_OVERRIDES: Record<number, string> = {
  10759: 'Acción y aventura',
  10762: 'Infantil',
  10763: 'Noticias',
  10764: 'Reality',
  10765: 'Ciencia ficción y fantasía',
  10766: 'Telenovela',
  10767: 'Entrevistas',
  10768: 'Bélica y política',
};

export interface GenreIndex {
  nameOf(type: TmdbMediaType, id: number): string | undefined;
  idOf(type: TmdbMediaType, name: string): number | undefined;
}

export function genreIndex(store: Store, language: string): GenreIndex {
  const spanish = language.toLowerCase().startsWith('es');
  const byId = new Map<string, string>();
  const byName = new Map<string, number>();
  for (const type of ['movie', 'tv'] as const) {
    for (const g of store.genres(type, language)) {
      const name = (spanish && SPANISH_OVERRIDES[g.genre_id]) || g.name;
      byId.set(`${type}:${g.genre_id}`, name);
      byName.set(`${type}:${name.toLowerCase()}`, g.genre_id);
      // Se acepta también el nombre original de TMDB.
      byName.set(`${type}:${g.name.toLowerCase()}`, g.genre_id);
    }
  }
  return {
    nameOf: (type, id) => byId.get(`${type}:${id}`),
    idOf: (type, name) => byName.get(`${type}:${name.trim().toLowerCase()}`),
  };
}
