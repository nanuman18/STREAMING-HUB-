import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Esquema SQL. Se mantiene dentro de SQL estándar (ON CONFLICT, sin funciones JSON)
 * para que la migración a PostgreSQL consista en portar este archivo y SqliteStore.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE titles (
    media_type        TEXT    NOT NULL CHECK (media_type IN ('movie', 'tv')),
    tmdb_id           INTEGER NOT NULL,
    imdb_id           TEXT,
    imdb_status       TEXT    NOT NULL DEFAULT 'pending' CHECK (imdb_status IN ('pending', 'found', 'missing', 'gone')),
    imdb_checked_at   INTEGER,
    title             TEXT    NOT NULL,
    original_title    TEXT,
    overview          TEXT,
    release_date      TEXT,
    year              INTEGER,
    poster_path       TEXT,
    backdrop_path     TEXT,
    popularity        REAL    NOT NULL DEFAULT 0,
    vote_average      REAL    NOT NULL DEFAULT 0,
    vote_count        INTEGER NOT NULL DEFAULT 0,
    original_language TEXT,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (media_type, tmdb_id)
  );
  CREATE INDEX titles_imdb ON titles (imdb_id);
  CREATE INDEX titles_imdb_status ON titles (imdb_status, imdb_checked_at);

  CREATE TABLE title_genres (
    media_type TEXT    NOT NULL,
    tmdb_id    INTEGER NOT NULL,
    genre_id   INTEGER NOT NULL,
    PRIMARY KEY (media_type, tmdb_id, genre_id)
  );
  CREATE INDEX title_genres_genre ON title_genres (media_type, genre_id);

  CREATE TABLE availability (
    region           TEXT    NOT NULL,
    platform         TEXT    NOT NULL,
    media_type       TEXT    NOT NULL,
    tmdb_id          INTEGER NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    first_seen_at    INTEGER NOT NULL,
    last_seen_at     INTEGER NOT NULL,
    last_verified_at INTEGER NOT NULL,
    removed_at       INTEGER,
    baseline         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (region, platform, media_type, tmdb_id)
  );
  CREATE INDEX availability_catalog ON availability (region, platform, media_type, status);

  CREATE TABLE title_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    region     TEXT    NOT NULL,
    platform   TEXT    NOT NULL,
    media_type TEXT    NOT NULL,
    tmdb_id    INTEGER NOT NULL,
    event      TEXT    NOT NULL CHECK (event IN ('added', 'removed', 'readded')),
    at         INTEGER NOT NULL
  );
  CREATE INDEX title_events_at ON title_events (region, platform, at);

  CREATE TABLE genres (
    media_type TEXT    NOT NULL,
    genre_id   INTEGER NOT NULL,
    language   TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (media_type, genre_id, language)
  );

  CREATE TABLE tmdb_providers (
    region      TEXT    NOT NULL,
    media_type  TEXT    NOT NULL,
    provider_id INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    priority    INTEGER,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (region, media_type, provider_id)
  );

  CREATE TABLE platform_providers (
    region         TEXT    NOT NULL,
    platform       TEXT    NOT NULL,
    provider_ids   TEXT    NOT NULL,
    provider_names TEXT    NOT NULL,
    resolved_at    INTEGER NOT NULL,
    PRIMARY KEY (region, platform)
  );

  CREATE TABLE sync_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL CHECK (kind IN ('incremental', 'full')),
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    status      TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    stats       TEXT,
    error       TEXT
  );

  CREATE TABLE harvest_status (
    region              TEXT    NOT NULL,
    platform            TEXT    NOT NULL,
    media_type          TEXT    NOT NULL,
    last_incremental_at INTEGER,
    last_full_at        INTEGER,
    last_full_complete  INTEGER NOT NULL DEFAULT 0,
    total_results       INTEGER,
    collected           INTEGER,
    last_error          TEXT,
    PRIMARY KEY (region, platform, media_type)
  );

  CREATE TABLE locks (
    name       TEXT    PRIMARY KEY,
    owner      TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: búsqueda de disponibilidad por título (resolución de IMDb ID). Sin él, cada comprobación recorría la tabla entera.
  `
  CREATE INDEX IF NOT EXISTS availability_title ON availability (media_type, tmdb_id, status);
  `,
  // 3: logo de cada proveedor (icono de la plataforma en Stremio).
  `
  ALTER TABLE tmdb_providers ADD COLUMN logo_path TEXT;
  `,
];

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Ejecuta fn dentro de una transacción. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
