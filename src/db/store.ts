import { tx, type Db } from './database.js';
import type { TmdbDiscoverItem, TmdbGenre, TmdbMediaType, TmdbProvider } from '../tmdb/types.js';

export type SortMode = 'popularity' | 'new' | 'release' | 'rating';
export type SyncKind = 'incremental' | 'full';
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';

export interface CatalogRow {
  media_type: TmdbMediaType;
  tmdb_id: number;
  imdb_id: string;
  title: string;
  overview: string | null;
  release_date: string | null;
  year: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  popularity: number;
  vote_average: number;
  vote_count: number;
}

export interface CatalogQuery {
  region: string;
  platform: string;
  type: TmdbMediaType;
  sort: SortMode;
  genreId?: number;
  skip: number;
  limit: number;
  /** Fecha actual (YYYY-MM-DD) para excluir estrenos futuros al ordenar por fecha. */
  today: string;
}

export interface MarkSeenResult {
  added: number[];
  readded: number[];
}

export interface HarvestStatusRow {
  region: string;
  platform: string;
  media_type: TmdbMediaType;
  last_incremental_at: number | null;
  last_full_at: number | null;
  last_full_complete: number;
  total_results: number | null;
  collected: number | null;
  last_error: string | null;
}

export interface RunRow {
  id: number;
  kind: SyncKind;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  stats: string | null;
  error: string | null;
}

/** Votos mínimos para entrar en el orden por valoración (evita títulos con 1 voto de 10). */
export const MIN_VOTES: Record<TmdbMediaType, number> = { movie: 100, tv: 50 };

const CHUNK = 400;

function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/**
 * Acceso a datos. Toda la lógica SQL vive aquí para poder sustituir SQLite
 * por PostgreSQL implementando los mismos métodos.
 */
export class Store {
  constructor(readonly db: Db) {}

  // ---------------------------------------------------------------- títulos

  upsertTitles(type: TmdbMediaType, items: TmdbDiscoverItem[], now: number): void {
    if (!items.length) return;
    const up = this.db.prepare(`
      INSERT INTO titles (media_type, tmdb_id, title, original_title, overview, release_date, year,
                          poster_path, backdrop_path, popularity, vote_average, vote_count, original_language, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
        title = excluded.title, original_title = excluded.original_title, overview = excluded.overview,
        release_date = excluded.release_date, year = excluded.year, poster_path = excluded.poster_path,
        backdrop_path = excluded.backdrop_path, popularity = excluded.popularity,
        vote_average = excluded.vote_average, vote_count = excluded.vote_count,
        original_language = excluded.original_language, updated_at = excluded.updated_at`);
    const delGenres = this.db.prepare('DELETE FROM title_genres WHERE media_type = ? AND tmdb_id = ?');
    const addGenre = this.db.prepare('INSERT OR IGNORE INTO title_genres (media_type, tmdb_id, genre_id) VALUES (?, ?, ?)');
    tx(this.db, () => {
      for (const it of items) {
        const date = (type === 'movie' ? it.release_date : it.first_air_date) || null;
        const year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
        const title = (type === 'movie' ? it.title : it.name) || (type === 'movie' ? it.original_title : it.original_name) || `TMDB ${it.id}`;
        up.run(
          type, it.id, title,
          (type === 'movie' ? it.original_title : it.original_name) ?? null,
          it.overview || null, date, year,
          it.poster_path ?? null, it.backdrop_path ?? null,
          it.popularity ?? 0, it.vote_average ?? 0, it.vote_count ?? 0,
          it.original_language ?? null, now,
        );
        if (Array.isArray(it.genre_ids)) {
          delGenres.run(type, it.id);
          for (const g of it.genre_ids) addGenre.run(type, it.id, g);
        }
      }
    });
  }

  /** Títulos cuyo IMDb ID hay que consultar: nunca consultados, o sin IMDb y consultados hace tiempo. */
  titlesNeedingImdb(retryBefore: number, limit: number): Array<{ media_type: TmdbMediaType; tmdb_id: number }> {
    return this.db.prepare(`
      SELECT t.media_type, t.tmdb_id FROM titles t
      WHERE (t.imdb_status = 'pending' OR (t.imdb_status = 'missing' AND t.imdb_checked_at < ?))
        AND EXISTS (SELECT 1 FROM availability a WHERE a.media_type = t.media_type AND a.tmdb_id = t.tmdb_id AND a.status = 'active')
      ORDER BY t.imdb_status = 'pending' DESC, t.popularity DESC
      LIMIT ?`).all(retryBefore, limit) as Array<{ media_type: TmdbMediaType; tmdb_id: number }>;
  }

  setImdb(type: TmdbMediaType, tmdbId: number, imdbId: string | null, status: 'found' | 'missing' | 'gone', now: number): void {
    this.db.prepare('UPDATE titles SET imdb_id = ?, imdb_status = ?, imdb_checked_at = ? WHERE media_type = ? AND tmdb_id = ?')
      .run(imdbId, status, now, type, tmdbId);
  }

  getTitle(type: TmdbMediaType, tmdbId: number): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM titles WHERE media_type = ? AND tmdb_id = ?').get(type, tmdbId) as Record<string, unknown> | undefined;
  }

  // ---------------------------------------------------------- disponibilidad

  /**
   * Registra que los títulos se han visto en la plataforma. Devuelve los que son nuevos
   * (o vuelven tras una retirada). `baseline` marca la primera carga, que no cuenta como novedad.
   */
  markSeen(region: string, platform: string, type: TmdbMediaType, ids: number[], now: number, baseline: boolean): MarkSeenResult {
    const result: MarkSeenResult = { added: [], readded: [] };
    if (!ids.length) return result;
    const unique = [...new Set(ids)];
    tx(this.db, () => {
      const event = this.db.prepare('INSERT INTO title_events (region, platform, media_type, tmdb_id, event, at) VALUES (?, ?, ?, ?, ?, ?)');
      const insert = this.db.prepare(`INSERT INTO availability (region, platform, media_type, tmdb_id, status, first_seen_at, last_seen_at, last_verified_at, baseline)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`);
      const reactivate = this.db.prepare(`UPDATE availability SET status = 'active', removed_at = NULL, last_seen_at = ?, last_verified_at = ?, first_seen_at = ?, baseline = 0
        WHERE region = ? AND platform = ? AND media_type = ? AND tmdb_id = ?`);
      const touch = this.db.prepare(`UPDATE availability SET last_seen_at = ?, last_verified_at = ?
        WHERE region = ? AND platform = ? AND media_type = ? AND tmdb_id = ?`);
      for (const part of chunks(unique)) {
        const existing = new Map(
          (this.db.prepare(`SELECT tmdb_id, status FROM availability WHERE region = ? AND platform = ? AND media_type = ? AND tmdb_id IN (${placeholders(part.length)})`)
            .all(region, platform, type, ...part) as Array<{ tmdb_id: number; status: string }>).map((r) => [r.tmdb_id, r.status]),
        );
        for (const id of part) {
          const status = existing.get(id);
          if (status === undefined) {
            insert.run(region, platform, type, id, now, now, now, baseline ? 1 : 0);
            if (!baseline) {
              event.run(region, platform, type, id, 'added', now);
              result.added.push(id);
            }
          } else if (status === 'removed') {
            reactivate.run(now, now, now, region, platform, type, id);
            event.run(region, platform, type, id, 'readded', now);
            result.readded.push(id);
          } else {
            touch.run(now, now, region, platform, type, id);
          }
        }
      }
    });
    return result;
  }

  /** Activos que no se vieron desde `since` (candidatos a retirada tras una recogida completa). */
  unseenSince(region: string, platform: string, type: TmdbMediaType, since: number): number[] {
    return (this.db.prepare(`SELECT tmdb_id FROM availability WHERE region = ? AND platform = ? AND media_type = ? AND status = 'active' AND last_seen_at < ?`)
      .all(region, platform, type, since) as Array<{ tmdb_id: number }>).map((r) => r.tmdb_id);
  }

  /** Confirmado individualmente que el título sigue en la plataforma aunque Discover no lo devolviera. */
  markVerified(region: string, platform: string, type: TmdbMediaType, tmdbId: number, now: number): void {
    this.db.prepare('UPDATE availability SET last_verified_at = ?, last_seen_at = ? WHERE region = ? AND platform = ? AND media_type = ? AND tmdb_id = ?')
      .run(now, now, region, platform, type, tmdbId);
  }

  markRemoved(region: string, platform: string, type: TmdbMediaType, tmdbId: number, now: number): void {
    tx(this.db, () => {
      const r = this.db.prepare(`UPDATE availability SET status = 'removed', removed_at = ?, last_verified_at = ?
        WHERE region = ? AND platform = ? AND media_type = ? AND tmdb_id = ? AND status = 'active'`)
        .run(now, now, region, platform, type, tmdbId);
      if (Number(r.changes) > 0) {
        this.db.prepare('INSERT INTO title_events (region, platform, media_type, tmdb_id, event, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(region, platform, type, tmdbId, 'removed', now);
      }
    });
  }

  availabilityOf(region: string, platform: string, type: TmdbMediaType, tmdbId: number): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM availability WHERE region = ? AND platform = ? AND media_type = ? AND tmdb_id = ?')
      .get(region, platform, type, tmdbId) as Record<string, unknown> | undefined;
  }

  countActive(region: string, platform: string, type: TmdbMediaType): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM availability WHERE region = ? AND platform = ? AND media_type = ? AND status = 'active'`)
      .get(region, platform, type) as { n: number };
    return r.n;
  }

  hasAnyAvailability(region: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM availability WHERE region = ? LIMIT 1').get(region);
  }

  // ------------------------------------------------------------------ catálogo

  listCatalog(q: CatalogQuery): CatalogRow[] {
    const params: Array<string | number> = [q.region, q.platform, q.type];
    let where = `a.region = ? AND a.platform = ? AND a.media_type = ? AND a.status = 'active' AND t.imdb_id IS NOT NULL`;
    if (q.genreId !== undefined) {
      where += ' AND EXISTS (SELECT 1 FROM title_genres g WHERE g.media_type = t.media_type AND g.tmdb_id = t.tmdb_id AND g.genre_id = ?)';
      params.push(q.genreId);
    }
    let order: string;
    switch (q.sort) {
      case 'release':
        where += ' AND t.release_date IS NOT NULL AND t.release_date <= ?';
        params.push(q.today);
        order = 'MAX(t.release_date) DESC, MAX(t.popularity) DESC';
        break;
      case 'rating':
        where += ' AND t.vote_count >= ?';
        params.push(MIN_VOTES[q.type]);
        order = 'MAX(t.vote_average) DESC, MAX(t.vote_count) DESC';
        break;
      case 'new':
        // Primero lo detectado después de la carga inicial, del más reciente al más antiguo; después, por popularidad.
        order = 'MAX(CASE WHEN a.baseline = 0 THEN a.first_seen_at ELSE 0 END) DESC, MAX(t.popularity) DESC';
        break;
      default:
        order = 'MAX(t.popularity) DESC';
    }
    params.push(q.limit, q.skip);
    // GROUP BY imdb_id: dos fichas de TMDB con el mismo IMDb ID se muestran una sola vez.
    return this.db.prepare(`
      SELECT t.media_type, t.tmdb_id, t.imdb_id, t.title, t.overview, t.release_date, t.year, t.poster_path,
             t.backdrop_path, MAX(t.popularity) AS popularity, t.vote_average, t.vote_count
      FROM availability a JOIN titles t ON t.media_type = a.media_type AND t.tmdb_id = a.tmdb_id
      WHERE ${where}
      GROUP BY t.imdb_id
      ORDER BY ${order}, MIN(t.tmdb_id)
      LIMIT ? OFFSET ?`).all(...params) as unknown as CatalogRow[];
  }

  genreIdsByTitle(type: TmdbMediaType, ids: number[]): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const part of chunks(ids)) {
      const rows = this.db.prepare(`SELECT tmdb_id, genre_id FROM title_genres WHERE media_type = ? AND tmdb_id IN (${placeholders(part.length)})`)
        .all(type, ...part) as Array<{ tmdb_id: number; genre_id: number }>;
      for (const r of rows) {
        const list = out.get(r.tmdb_id) ?? [];
        list.push(r.genre_id);
        out.set(r.tmdb_id, list);
      }
    }
    return out;
  }

  /** Géneros presentes en un catálogo (con IMDb ID), con su número de títulos. */
  genreCounts(region: string, platform: string, type: TmdbMediaType): Array<{ genre_id: number; n: number }> {
    return this.db.prepare(`
      SELECT g.genre_id, COUNT(DISTINCT t.imdb_id) AS n
      FROM availability a
      JOIN titles t ON t.media_type = a.media_type AND t.tmdb_id = a.tmdb_id
      JOIN title_genres g ON g.media_type = t.media_type AND g.tmdb_id = t.tmdb_id
      WHERE a.region = ? AND a.platform = ? AND a.media_type = ? AND a.status = 'active' AND t.imdb_id IS NOT NULL
      GROUP BY g.genre_id ORDER BY n DESC`).all(region, platform, type) as Array<{ genre_id: number; n: number }>;
  }

  // ------------------------------------------------------------------ géneros

  replaceGenres(type: TmdbMediaType, language: string, genres: TmdbGenre[], now: number): void {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM genres WHERE media_type = ? AND language = ?').run(type, language);
      const ins = this.db.prepare('INSERT INTO genres (media_type, genre_id, language, name, fetched_at) VALUES (?, ?, ?, ?, ?)');
      for (const g of genres) ins.run(type, g.id, language, g.name, now);
    });
  }

  genres(type: TmdbMediaType, language: string): Array<{ genre_id: number; name: string; fetched_at: number }> {
    return this.db.prepare('SELECT genre_id, name, fetched_at FROM genres WHERE media_type = ? AND language = ? ORDER BY name')
      .all(type, language) as Array<{ genre_id: number; name: string; fetched_at: number }>;
  }

  // -------------------------------------------------------------- proveedores

  replaceProviders(region: string, type: TmdbMediaType, providers: TmdbProvider[], now: number): void {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM tmdb_providers WHERE region = ? AND media_type = ?').run(region, type);
      const ins = this.db.prepare('INSERT INTO tmdb_providers (region, media_type, provider_id, name, priority, logo_path, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const p of providers) ins.run(region, type, p.provider_id, p.provider_name, p.display_priorities?.[region] ?? null, p.logo_path ?? null, now);
    });
  }

  providers(region: string): Array<{ media_type: TmdbMediaType; provider_id: number; name: string; priority: number | null; logo_path: string | null; fetched_at: number }> {
    return this.db.prepare('SELECT media_type, provider_id, name, priority, logo_path, fetched_at FROM tmdb_providers WHERE region = ? ORDER BY priority')
      .all(region) as Array<{ media_type: TmdbMediaType; provider_id: number; name: string; priority: number | null; logo_path: string | null; fetched_at: number }>;
  }

  setPlatformProviders(region: string, platform: string, ids: number[], names: string[], now: number): void {
    this.db.prepare(`INSERT INTO platform_providers (region, platform, provider_ids, provider_names, resolved_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (region, platform) DO UPDATE SET provider_ids = excluded.provider_ids, provider_names = excluded.provider_names, resolved_at = excluded.resolved_at`)
      .run(region, platform, JSON.stringify(ids), JSON.stringify(names), now);
  }

  platformProviders(region: string): Map<string, { ids: number[]; names: string[]; resolvedAt: number }> {
    const rows = this.db.prepare('SELECT platform, provider_ids, provider_names, resolved_at FROM platform_providers WHERE region = ?')
      .all(region) as Array<{ platform: string; provider_ids: string; provider_names: string; resolved_at: number }>;
    return new Map(rows.map((r) => [r.platform, { ids: JSON.parse(r.provider_ids), names: JSON.parse(r.provider_names), resolvedAt: r.resolved_at }]));
  }

  // ---------------------------------------------------------- ejecuciones

  startRun(kind: SyncKind, now: number): number {
    const r = this.db.prepare(`INSERT INTO sync_runs (kind, started_at, status) VALUES (?, ?, 'running')`).run(kind, now);
    return Number(r.lastInsertRowid);
  }

  finishRun(id: number, status: Exclude<RunStatus, 'running'>, now: number, stats: unknown, error?: string): void {
    this.db.prepare('UPDATE sync_runs SET status = ?, finished_at = ?, stats = ?, error = ? WHERE id = ?')
      .run(status, now, JSON.stringify(stats), error ?? null, id);
  }

  /** Marca como fallidas las ejecuciones que quedaron "running" por un proceso interrumpido (si nadie tiene el bloqueo). */
  failStaleRuns(now: number): void {
    this.db.prepare(`UPDATE sync_runs SET status = 'failed', finished_at = ?, error = 'interrumpida'
      WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM locks WHERE name = 'sync' AND expires_at > ?)`).run(now, now);
  }

  lastRun(kind?: SyncKind, statuses: RunStatus[] = ['ok', 'partial']): RunRow | undefined {
    const params: Array<string> = [...statuses];
    let sql = `SELECT * FROM sync_runs WHERE status IN (${placeholders(statuses.length)})`;
    if (kind) {
      sql += ' AND kind = ?';
      params.push(kind);
    }
    return this.db.prepare(sql + ' ORDER BY started_at DESC, id DESC LIMIT 1').get(...params) as RunRow | undefined;
  }

  recentRuns(limit = 10): RunRow[] {
    return this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit) as unknown as RunRow[];
  }

  updateHarvestStatus(row: Partial<HarvestStatusRow> & Pick<HarvestStatusRow, 'region' | 'platform' | 'media_type'>): void {
    const current = this.db.prepare('SELECT * FROM harvest_status WHERE region = ? AND platform = ? AND media_type = ?')
      .get(row.region, row.platform, row.media_type) as HarvestStatusRow | undefined;
    const m = { last_incremental_at: null, last_full_at: null, last_full_complete: 0, total_results: null, collected: null, last_error: null, ...current, ...row };
    this.db.prepare(`INSERT INTO harvest_status (region, platform, media_type, last_incremental_at, last_full_at, last_full_complete, total_results, collected, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (region, platform, media_type) DO UPDATE SET last_incremental_at = excluded.last_incremental_at, last_full_at = excluded.last_full_at,
        last_full_complete = excluded.last_full_complete, total_results = excluded.total_results, collected = excluded.collected, last_error = excluded.last_error`)
      .run(m.region, m.platform, m.media_type, m.last_incremental_at, m.last_full_at, m.last_full_complete, m.total_results, m.collected, m.last_error);
  }

  harvestStatus(region?: string): HarvestStatusRow[] {
    if (region) return this.db.prepare('SELECT * FROM harvest_status WHERE region = ?').all(region) as unknown as HarvestStatusRow[];
    return this.db.prepare('SELECT * FROM harvest_status').all() as unknown as HarvestStatusRow[];
  }

  /** Recuento por catálogo para la página de estado. */
  catalogStats(region: string): Array<{ platform: string; media_type: TmdbMediaType; active: number; with_imdb: number; without_imdb: number; pending_imdb: number; removed: number; added_7d: number }> {
    const weekAgo = Date.now() - 7 * 86_400_000;
    return this.db.prepare(`
      SELECT a.platform, a.media_type,
        SUM(a.status = 'active') AS active,
        SUM(a.status = 'active' AND t.imdb_id IS NOT NULL) AS with_imdb,
        SUM(a.status = 'active' AND t.imdb_status IN ('missing', 'gone')) AS without_imdb,
        SUM(a.status = 'active' AND t.imdb_status = 'pending') AS pending_imdb,
        SUM(a.status = 'removed') AS removed,
        SUM(a.status = 'active' AND a.baseline = 0 AND a.first_seen_at >= ?) AS added_7d
      FROM availability a JOIN titles t ON t.media_type = a.media_type AND t.tmdb_id = a.tmdb_id
      WHERE a.region = ?
      GROUP BY a.platform, a.media_type`).all(weekAgo, region) as unknown as Array<{ platform: string; media_type: TmdbMediaType; active: number; with_imdb: number; without_imdb: number; pending_imdb: number; removed: number; added_7d: number }>;
  }

  // ---------------------------------------------------------------- bloqueo

  /** Bloqueo con caducidad: evita dos sincronizaciones a la vez (también entre procesos que compartan la BD). */
  acquireLock(name: string, owner: string, ttlMs: number, now: number): boolean {
    return tx(this.db, () => {
      this.db.prepare('DELETE FROM locks WHERE name = ? AND expires_at < ?').run(name, now);
      this.db.prepare('INSERT OR IGNORE INTO locks (name, owner, expires_at) VALUES (?, ?, ?)').run(name, owner, now + ttlMs);
      const row = this.db.prepare('SELECT owner FROM locks WHERE name = ?').get(name) as { owner: string } | undefined;
      return row?.owner === owner;
    });
  }

  renewLock(name: string, owner: string, ttlMs: number, now: number): boolean {
    const r = this.db.prepare('UPDATE locks SET expires_at = ? WHERE name = ? AND owner = ?').run(now + ttlMs, name, owner);
    return Number(r.changes) > 0;
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(name, owner);
  }

  // ------------------------------------------------------------------- meta

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Versión de datos: cambia tras cada sincronización y sirve para invalidar cachés de catálogo. */
  dataVersion(): number {
    return Number(this.getMeta('data_version') ?? 0);
  }

  bumpDataVersion(): number {
    const v = this.dataVersion() + 1;
    this.setMeta('data_version', String(v));
    return v;
  }

  ping(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }
}
