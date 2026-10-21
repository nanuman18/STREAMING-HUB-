import path from 'node:path';
import { AddonService } from '../../src/addon/addon.js';
import type { ConfigLimits } from '../../src/addon/userConfig.js';
import { loadPlatforms } from '../../src/config/platforms.js';
import { openDatabase } from '../../src/db/database.js';
import { Store } from '../../src/db/store.js';
import { SyncService, type SyncOptions } from '../../src/sync/service.js';
import { FakeTmdb } from './fakeTmdb.js';

export const PLATFORMS = loadPlatforms(path.resolve(import.meta.dirname, '../../config/platforms.json'));

export function makeEnv(opts: Partial<SyncOptions> = {}, fake = new FakeTmdb()) {
  const store = new Store(openDatabase(':memory:'));
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const now = () => clock;
  const sync = new SyncService(store, fake, PLATFORMS, {
    regions: ['ES'],
    language: 'es-ES',
    monetization: ['flatrate', 'free', 'ads'],
    incrementalPages: 2,
    maxPagesPerQuery: 0,
    onlyPlatforms: null,
    imdbRetryDays: 3,
    ...opts,
  }, now);
  const limits: ConfigLimits = { platformKeys: PLATFORMS.map((p) => p.key), regions: ['ES'], languages: ['es-ES'] };
  const addon = new AddonService(store, PLATFORMS, limits, now);
  return {
    store, fake, sync, addon, limits, now,
    advance(ms: number) { clock += ms; },
  };
}
