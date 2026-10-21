import { toStremioType } from '../addon/addon.js';
import type { PlatformDef } from '../config/platforms.js';
import type { Store } from '../db/store.js';

/** Estado público (recuentos y últimas sincronizaciones). Lo usan /api/status y el sitio estático. */
export function buildStatus(store: Store, platforms: PlatformDef[], regionList: string[], syncing = false) {
  const names = new Map(platforms.map((p) => [p.key, p.name]));
  const regions = regionList.map((region) => {
    const harvest = new Map(store.harvestStatus(region).map((h) => [`${h.platform}/${h.media_type}`, h]));
    return {
      region,
      catalogs: store.catalogStats(region).map((s) => {
        const h = harvest.get(`${s.platform}/${s.media_type}`);
        return {
          platform: s.platform,
          name: names.get(s.platform) ?? s.platform,
          type: toStremioType(s.media_type),
          visible: s.with_imdb,
          active: s.active,
          withoutImdb: s.without_imdb,
          pendingImdb: s.pending_imdb,
          removed: s.removed,
          addedLast7Days: s.added_7d,
          tmdbTotal: h?.total_results ?? null,
          lastFullAt: h?.last_full_at ?? null,
          lastFullComplete: !!h?.last_full_complete,
          lastIncrementalAt: h?.last_incremental_at ?? null,
          lastError: h?.last_error ?? null,
        };
      }),
    };
  });
  const runs = store.recentRuns(5).map((r) => ({
    kind: r.kind, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
  }));
  return {
    lastUpdate: store.lastRun()?.finished_at ?? null,
    syncing,
    runs,
    regions,
  };
}
