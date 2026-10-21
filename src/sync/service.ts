import { randomUUID } from 'node:crypto';
import type { PlatformDef } from '../config/platforms.js';
import type { Store, SyncKind } from '../db/store.js';
import { TmdbError } from '../tmdb/client.js';
import type { TmdbApi, TmdbMediaType, TmdbRegionOffers } from '../tmdb/types.js';
import { createLogger } from '../util/logger.js';
import { harvestFull, harvestIncremental, type HarvestResult } from './harvest.js';
import { resolvePlatforms, type ResolvedPlatform } from './providers.js';

const log = createLogger('sync');

export const MEDIA_TYPES: TmdbMediaType[] = ['movie', 'tv'];
const LOCK_NAME = 'sync';
const LOCK_TTL_MS = 10 * 60_000;
const GENRE_TTL_MS = 7 * 86_400_000;

export interface SyncOptions {
  regions: string[];
  language: string;
  monetization: string[];
  incrementalPages: number;
  maxPagesPerQuery: number;
  onlyPlatforms: string[] | null;
  imdbRetryDays: number;
  /** Máximo de candidatos a retirada que se verifican uno a uno por catálogo y ejecución. */
  maxRemovalChecks?: number;
  /** Máximo de IMDb ID que se buscan por ejecución (0 = sin límite). */
  maxImdbLookups?: number;
  /** Solo para pruebas: límite de páginas de la API simulada. */
  apiMaxPage?: number;
}

export interface CatalogReport {
  region: string;
  platform: string;
  type: TmdbMediaType;
  totalResults: number;
  collected: number;
  pagesFetched: number;
  pagesFailed: number;
  complete: boolean;
  partitioned: boolean;
  added: number;
  readded: number;
  removalCandidates: number;
  removed: number;
  confirmedPresent: number;
  errors: string[];
  notes: string[];
}

export interface SyncReport {
  runId: number;
  kind: SyncKind;
  status: 'ok' | 'partial' | 'failed';
  startedAt: number;
  finishedAt: number;
  catalogs: CatalogReport[];
  imdb: { checked: number; found: number; missing: number; gone: number; failed: number };
  unresolvedPlatforms: string[];
  errors: string[];
}

export class SyncBusyError extends Error {
  constructor() {
    super('Ya hay una sincronización en curso');
  }
}

export class SyncService {
  private running: Promise<SyncReport> | null = null;
  private readonly owner = randomUUID();

  constructor(
    private readonly store: Store,
    private readonly tmdb: TmdbApi,
    private readonly platforms: PlatformDef[],
    private readonly opts: SyncOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Ejecuta una sincronización. Lanza SyncBusyError si ya hay otra en este proceso o en otro con la misma BD. */
  async run(kind: SyncKind): Promise<SyncReport> {
    if (this.running) throw new SyncBusyError();
    if (!this.store.acquireLock(LOCK_NAME, this.owner, LOCK_TTL_MS, this.now())) throw new SyncBusyError();
    const heartbeat = setInterval(() => this.store.renewLock(LOCK_NAME, this.owner, LOCK_TTL_MS, this.now()), 60_000);
    heartbeat.unref();
    this.running = this.doRun(kind).finally(() => {
      clearInterval(heartbeat);
      this.store.releaseLock(LOCK_NAME, this.owner);
      this.running = null;
    });
    return this.running;
  }

  private async doRun(kind: SyncKind): Promise<SyncReport> {
    const startedAt = this.now();
    const runId = this.store.startRun(kind, startedAt);
    const report: SyncReport = {
      runId,
      kind,
      status: 'ok',
      startedAt,
      finishedAt: startedAt,
      catalogs: [],
      imdb: { checked: 0, found: 0, missing: 0, gone: 0, failed: 0 },
      unresolvedPlatforms: [],
      errors: [],
    };
    log.info(`Inicio de sincronización ${kind}`, { runId });
    try {
      const platforms = this.opts.onlyPlatforms ? this.platforms.filter((p) => this.opts.onlyPlatforms!.includes(p.key)) : this.platforms;
      for (const region of this.opts.regions) {
        await this.refreshGenres();
        const { resolved, fromCache } = await resolvePlatforms(this.tmdb, this.store, platforms, region, this.opts.language, this.now());
        if (fromCache) report.errors.push(`proveedores de ${region}: TMDB no respondió, se usó la última resolución guardada`);
        for (const p of platforms) {
          const r = resolved.get(p.key);
          if (!r) {
            report.unresolvedPlatforms.push(`${p.key}@${region}`);
            continue;
          }
          for (const type of MEDIA_TYPES) {
            report.catalogs.push(await this.syncCatalog(kind, region, r, type));
          }
        }
      }
      report.imdb = await this.resolveImdbIds();
      const failedCatalogs = report.catalogs.filter((c) => c.pagesFetched === 0 && c.errors.length).length;
      if (report.catalogs.length && failedCatalogs === report.catalogs.length) report.status = 'failed';
      else if (failedCatalogs || report.catalogs.some((c) => c.pagesFailed) || report.errors.length) report.status = 'partial';
    } catch (err) {
      report.status = 'failed';
      report.errors.push((err as Error).message);
      log.error('Sincronización fallida', { error: (err as Error).message });
    }
    report.finishedAt = this.now();
    this.store.bumpDataVersion();
    this.store.finishRun(runId, report.status, report.finishedAt, summarize(report), report.errors.join(' | ') || undefined);
    log.info(`Fin de sincronización ${kind}: ${report.status}`, summarize(report));
    return report;
  }

  private async refreshGenres(): Promise<void> {
    for (const type of MEDIA_TYPES) {
      const cached = this.store.genres(type, this.opts.language);
      if (cached.length && this.now() - cached[0]!.fetched_at < GENRE_TTL_MS) continue;
      try {
        this.store.replaceGenres(type, this.opts.language, await this.tmdb.genres(type, this.opts.language), this.now());
      } catch (err) {
        log.warn('No se pudieron actualizar los géneros; se mantienen los guardados', { type, error: (err as Error).message });
      }
    }
  }

  private async syncCatalog(kind: SyncKind, region: string, r: ResolvedPlatform, type: TmdbMediaType): Promise<CatalogReport> {
    const platform = r.platform.key;
    const startedAt = this.now();
    const baselineKey = `baseline_done:${region}:${platform}:${type}`;
    const baseline = this.store.getMeta(baselineKey) !== '1';
    const rep: CatalogReport = {
      region, platform, type,
      totalResults: 0, collected: 0, pagesFetched: 0, pagesFailed: 0, complete: false, partitioned: false,
      added: 0, readded: 0, removalCandidates: 0, removed: 0, confirmedPresent: 0, errors: [], notes: [],
    };
    const target = {
      type, region, language: this.opts.language, providers: r.providerIds,
      monetization: r.platform.monetization ?? this.opts.monetization,
    };
    const onItems = (items: Parameters<Store['upsertTitles']>[1]) => {
      const now = this.now();
      this.store.upsertTitles(type, items, now);
      const seen = this.store.markSeen(region, platform, type, items.map((i) => i.id), now, baseline);
      rep.added += seen.added.length;
      rep.readded += seen.readded.length;
    };

    let h: HarvestResult;
    try {
      h = kind === 'full'
        ? await harvestFull(this.tmdb, target, {
          maxPagesPerQuery: this.opts.maxPagesPerQuery,
          ...(this.opts.apiMaxPage ? { apiMaxPage: this.opts.apiMaxPage } : {}),
          onItems,
          heartbeat: () => this.store.renewLock(LOCK_NAME, this.owner, LOCK_TTL_MS, this.now()),
        })
        : await harvestIncremental(this.tmdb, target, { pages: this.opts.incrementalPages, today: isoDay(this.now()), onItems });
    } catch (err) {
      rep.errors.push((err as Error).message);
      this.store.updateHarvestStatus({ region, platform, media_type: type, last_error: (err as Error).message });
      log.error(`Error recogiendo ${platform}/${type}`, { error: (err as Error).message });
      return rep;
    }
    Object.assign(rep, {
      totalResults: h.totalResults, collected: h.ids.size, pagesFetched: h.pagesFetched, pagesFailed: h.pagesFailed,
      complete: h.complete, partitioned: h.partitioned,
    });
    rep.errors.push(...h.errors);
    rep.notes.push(...h.notes);

    if (kind === 'full') {
      if (h.complete) {
        this.store.setMeta(baselineKey, '1');
        await this.verifyRemovals(region, r, type, startedAt, rep);
      } else {
        rep.notes.push('recogida incompleta: no se evalúan retiradas en esta ejecución');
      }
    }
    this.store.updateHarvestStatus({
      region, platform, media_type: type,
      ...(kind === 'full'
        ? { last_full_at: this.now(), last_full_complete: h.complete ? 1 : 0, total_results: h.totalResults, collected: h.ids.size }
        : { last_incremental_at: this.now() }),
      last_error: rep.errors.length ? rep.errors.slice(0, 3).join(' | ') : null,
    });
    log.info(`${r.platform.name} ${type} (${region}): ${h.ids.size}/${h.totalResults} recogidos`, {
      kind, added: rep.added, readded: rep.readded, removed: rep.removed, complete: h.complete,
    });
    return rep;
  }

  /**
   * Retiradas: un título que no aparece en una recogida completa es solo un candidato.
   * Se consulta su ficha de disponibilidad individual; solo si la plataforma ya no figura se da de baja.
   */
  private async verifyRemovals(region: string, r: ResolvedPlatform, type: TmdbMediaType, harvestStart: number, rep: CatalogReport): Promise<void> {
    const platform = r.platform.key;
    const candidates = this.store.unseenSince(region, platform, type, harvestStart);
    rep.removalCandidates = candidates.length;
    if (!candidates.length) return;
    const limit = this.opts.maxRemovalChecks ?? 2000;
    const monetization = r.platform.monetization ?? this.opts.monetization;
    const ids = new Set(r.providerIds);
    await Promise.all(
      candidates.slice(0, limit).map(async (tmdbId) => {
        try {
          const offers = await this.tmdb.titleOffers(type, tmdbId);
          if (offeredBy(offers[region], ids, monetization)) {
            this.store.markVerified(region, platform, type, tmdbId, this.now());
            rep.confirmedPresent++;
          } else {
            this.store.markRemoved(region, platform, type, tmdbId, this.now());
            rep.removed++;
          }
        } catch (err) {
          if (err instanceof TmdbError && err.status === 404) {
            // El título ya no existe en TMDB.
            this.store.markRemoved(region, platform, type, tmdbId, this.now());
            rep.removed++;
          } else {
            rep.errors.push(`verificación ${type}/${tmdbId}: ${(err as Error).message}`);
          }
        }
      }),
    );
    if (candidates.length > limit) rep.notes.push(`${candidates.length - limit} candidatos a retirada pendientes para la próxima ejecución`);
  }

  /** Resuelve IMDb ID mediante /external_ids. Los títulos sin IMDb se reintentan cada IMDB_RETRY_DAYS días. */
  private async resolveImdbIds(): Promise<SyncReport['imdb']> {
    const stats = { checked: 0, found: 0, missing: 0, gone: 0, failed: 0 };
    const max = this.opts.maxImdbLookups ?? 0;
    const retryBefore = this.now() - this.opts.imdbRetryDays * 86_400_000;
    const tried = new Set<string>();
    for (;;) {
      const room = max > 0 ? max - stats.checked : 500;
      if (room <= 0) break;
      const batch = this.store.titlesNeedingImdb(retryBefore, Math.min(500, room)).filter((t) => !tried.has(`${t.media_type}:${t.tmdb_id}`));
      if (!batch.length) break;
      await Promise.all(
        batch.map(async (t) => {
          tried.add(`${t.media_type}:${t.tmdb_id}`);
          stats.checked++;
          try {
            const imdb = await this.tmdb.imdbId(t.media_type, t.tmdb_id);
            this.store.setImdb(t.media_type, t.tmdb_id, imdb, imdb ? 'found' : 'missing', this.now());
            if (imdb) stats.found++;
            else stats.missing++;
          } catch (err) {
            if (err instanceof TmdbError && err.status === 404) {
              this.store.setImdb(t.media_type, t.tmdb_id, null, 'gone', this.now());
              stats.gone++;
            } else {
              stats.failed++;
            }
          }
        }),
      );
      this.store.renewLock(LOCK_NAME, this.owner, LOCK_TTL_MS, this.now());
      if (stats.checked % 2000 < batch.length) log.info('Resolviendo IMDb ID', stats);
    }
    return stats;
  }
}

export function offeredBy(offers: TmdbRegionOffers | undefined, providerIds: Set<number>, monetization: string[]): boolean {
  if (!offers) return false;
  return monetization.some((m) => (offers[m as keyof TmdbRegionOffers] ?? []).some((o) => providerIds.has(o.provider_id)));
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function summarize(r: SyncReport) {
  const sum = (k: keyof CatalogReport) => r.catalogs.reduce((a, c) => a + (c[k] as number), 0);
  return {
    catalogs: r.catalogs.length,
    collected: sum('collected'),
    added: sum('added'),
    readded: sum('readded'),
    removed: sum('removed'),
    confirmedPresent: sum('confirmedPresent'),
    pagesFetched: sum('pagesFetched'),
    pagesFailed: sum('pagesFailed'),
    incomplete: r.catalogs.filter((c) => !c.complete).map((c) => `${c.platform}/${c.type}`),
    imdb: r.imdb,
    unresolvedPlatforms: r.unresolvedPlatforms,
    durationS: Math.round((r.finishedAt - r.startedAt) / 1000),
  };
}
