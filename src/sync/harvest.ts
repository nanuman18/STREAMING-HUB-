import { TMDB_MAX_PAGE, type DiscoverParams, type TmdbApi, type TmdbDiscoverItem, type TmdbMediaType, type TmdbPage } from '../tmdb/types.js';

export interface HarvestTarget {
  type: TmdbMediaType;
  region: string;
  language: string;
  providers: number[];
  monetization: string[];
}

export interface HarvestResult {
  /** total_results que TMDB declara para la consulta sin filtro de fechas. */
  totalResults: number;
  /** ID únicos recogidos. */
  ids: Set<number>;
  pagesFetched: number;
  pagesFailed: number;
  /** Particiones que, aun siendo de un solo día, superaban 500 páginas y se truncaron. */
  truncatedPartitions: number;
  /** Se usó partición por fechas (la consulta superaba el máximo de 500 páginas). */
  partitioned: boolean;
  /** Se pidieron todas las páginas previstas sin errores ni truncados. Requisito para detectar retiradas. */
  complete: boolean;
  errors: string[];
  /** Avisos que no invalidan la recogida (p. ej. partición por fechas). */
  notes: string[];
}

export interface FullHarvestOptions {
  /** Límite de páginas por consulta (0 = sin límite). Solo para desarrollo: marca la recogida como incompleta. */
  maxPagesPerQuery: number;
  /** Se llama con cada página recibida (para guardar en la BD sobre la marcha). */
  onItems: (items: TmdbDiscoverItem[]) => void;
  /** Se llama periódicamente para mantener vivo el bloqueo de sincronización. */
  heartbeat?: () => void;
  /** Máximo de páginas que admite la API (500 en TMDB; configurable solo para pruebas). */
  apiMaxPage?: number;
}

const MIN_DATE = '1870-01-01';
const MAX_DATE = '2099-12-31';

function dateSort(type: TmdbMediaType): string {
  return type === 'movie' ? 'primary_release_date.asc' : 'first_air_date.asc';
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

/**
 * Recogida completa de lo que Discover expone para una plataforma.
 *
 * TMDB no ofrece un listado exhaustivo de catálogo por proveedor: solo /discover, que corta en 500 páginas
 * (10.000 resultados). Si una consulta lo supera, se divide recursivamente por rangos de fecha de estreno
 * hasta que cada rango cabe en 500 páginas. Los títulos SIN fecha quedan fuera de las consultas con rango
 * de fechas: es una limitación real y se refleja en `complete`/`totalResults` frente a `ids.size`.
 */
export async function harvestFull(tmdb: TmdbApi, target: HarvestTarget, opts: FullHarvestOptions): Promise<HarvestResult> {
  const result: HarvestResult = {
    totalResults: 0,
    ids: new Set(),
    pagesFetched: 0,
    pagesFailed: 0,
    truncatedPartitions: 0,
    partitioned: false,
    complete: true,
    errors: [],
    notes: [],
  };
  const apiMax = opts.apiMaxPage ?? TMDB_MAX_PAGE;
  const pageLimit = opts.maxPagesPerQuery > 0 ? Math.min(opts.maxPagesPerQuery, apiMax) : apiMax;

  const base = (page: number, dateGte?: string, dateLte?: string): DiscoverParams => ({
    region: target.region,
    language: target.language,
    providers: target.providers,
    monetization: target.monetization,
    sortBy: dateSort(target.type),
    page,
    ...(dateGte ? { dateGte } : {}),
    ...(dateLte ? { dateLte } : {}),
  });

  const accept = (page: TmdbPage<TmdbDiscoverItem>) => {
    result.pagesFetched++;
    const items = (page.results ?? []).filter((it) => Number.isInteger(it.id) && !it.adult);
    for (const it of items) result.ids.add(it.id);
    if (items.length) opts.onItems(items);
    opts.heartbeat?.();
  };

  /** Pide las páginas 2..n de una consulta cuya página 1 ya se tiene. */
  const fetchRest = async (first: TmdbPage<TmdbDiscoverItem>, dateGte?: string, dateLte?: string) => {
    const last = Math.min(first.total_pages, pageLimit);
    if (first.total_pages > pageLimit) {
      result.complete = false;
      if (opts.maxPagesPerQuery > 0) result.errors.push(`limitado a ${pageLimit} páginas por SYNC_MAX_PAGES`);
    }
    const pages = [];
    for (let p = 2; p <= last; p++) pages.push(p);
    await Promise.all(
      pages.map(async (p) => {
        try {
          accept(await tmdb.discover(target.type, base(p, dateGte, dateLte)));
        } catch (err) {
          result.pagesFailed++;
          result.complete = false;
          result.errors.push(`página ${p} (${dateGte ?? '-'}..${dateLte ?? '-'}): ${(err as Error).message}`);
        }
      }),
    );
  };

  const first = await tmdb.discover(target.type, base(1));
  result.totalResults = first.total_results;

  if (first.total_pages <= apiMax || opts.maxPagesPerQuery > 0) {
    accept(first);
    await fetchRest(first);
    return result;
  }

  // Más de 10.000 resultados: partición por fechas.
  result.partitioned = true;
  // Los títulos sin fecha no son alcanzables con filtro de fechas. No invalida la detección de retiradas:
  // cada candidato a retirada se verifica individualmente antes de darlo de baja.
  result.notes.push('consulta particionada por fechas: los títulos sin fecha de estreno no se recogen');

  const partition = async (from: string, to: string): Promise<void> => {
    let page1: TmdbPage<TmdbDiscoverItem>;
    try {
      page1 = await tmdb.discover(target.type, base(1, from, to));
    } catch (err) {
      result.pagesFailed++;
      result.complete = false;
      result.errors.push(`rango ${from}..${to}: ${(err as Error).message}`);
      return;
    }
    if (page1.total_pages <= apiMax) {
      accept(page1);
      await fetchRest(page1, from, to);
      return;
    }
    const span = daysBetween(from, to);
    if (span <= 0) {
      result.truncatedPartitions++;
      result.complete = false;
      result.errors.push(`el día ${from} supera 500 páginas; se trunca`);
      accept(page1);
      await fetchRest(page1, from, to);
      return;
    }
    const mid = addDays(from, Math.floor(span / 2));
    await partition(from, mid);
    await partition(addDays(mid, 1), to);
  };

  await partition(MIN_DATE, MAX_DATE);
  return result;
}

export interface IncrementalOptions {
  pages: number;
  today: string;
  onItems: (items: TmdbDiscoverItem[]) => void;
}

/**
 * Recogida incremental: primeras páginas por popularidad y por estreno más reciente.
 * Sirve para detectar novedades rápido; nunca se usa para deducir retiradas.
 */
export async function harvestIncremental(tmdb: TmdbApi, target: HarvestTarget, opts: IncrementalOptions): Promise<HarvestResult> {
  const result: HarvestResult = {
    totalResults: 0,
    ids: new Set(),
    pagesFetched: 0,
    pagesFailed: 0,
    truncatedPartitions: 0,
    partitioned: false,
    complete: false,
    errors: [],
    notes: [],
  };
  const dateDesc = target.type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc';
  const queries: Array<{ sortBy: string; dateLte?: string }> = [
    { sortBy: 'popularity.desc' },
    { sortBy: dateDesc, dateLte: opts.today },
  ];
  await Promise.all(
    queries.flatMap((q) =>
      Array.from({ length: opts.pages }, (_, i) => i + 1).map(async (page) => {
        try {
          const res = await tmdb.discover(target.type, {
            region: target.region,
            language: target.language,
            providers: target.providers,
            monetization: target.monetization,
            sortBy: q.sortBy,
            page,
            ...(q.dateLte ? { dateLte: q.dateLte } : {}),
          });
          if (q.sortBy === 'popularity.desc' && page === 1) result.totalResults = res.total_results;
          result.pagesFetched++;
          const items = (res.results ?? []).filter((it) => Number.isInteger(it.id) && !it.adult);
          for (const it of items) result.ids.add(it.id);
          if (items.length) opts.onItems(items);
        } catch (err) {
          result.pagesFailed++;
          result.errors.push(`${q.sortBy} p${page}: ${(err as Error).message}`);
        }
      }),
    ),
  );
  return result;
}
