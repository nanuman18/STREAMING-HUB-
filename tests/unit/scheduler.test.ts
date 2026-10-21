import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Store } from '../../src/db/store.js';
import { dueSync } from '../../src/sync/scheduler.js';
import { LruCache } from '../../src/util/lru.js';
import { RateLimiter } from '../../src/util/rateLimiter.js';

const H = 3_600_000;
const opts = { incrementalHours: 6, fullHours: 24, failureBackoffMinutes: 30 };

describe('calendario de actualizaciones', () => {
  it('completa si nunca hubo una; incremental cada 6 h; completa cada 24 h', () => {
    const store = new Store(openDatabase(':memory:'));
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    expect(dueSync(store, opts, t0)).toBe('full');
    store.finishRun(store.startRun('full', t0), 'ok', t0 + H / 2, {});
    expect(dueSync(store, opts, t0 + 5 * H)).toBeNull();
    expect(dueSync(store, opts, t0 + 6 * H)).toBe('incremental');
    store.finishRun(store.startRun('incremental', t0 + 6 * H), 'ok', t0 + 6 * H, {});
    expect(dueSync(store, opts, t0 + 11 * H)).toBeNull();
    expect(dueSync(store, opts, t0 + 12 * H)).toBe('incremental');
    expect(dueSync(store, opts, t0 + 24 * H)).toBe('full');
  });

  it('tras un fallo espera antes de reintentar', () => {
    const store = new Store(openDatabase(':memory:'));
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    store.finishRun(store.startRun('full', t0), 'failed', t0, {});
    expect(dueSync(store, opts, t0 + 10 * 60_000)).toBeNull();
    expect(dueSync(store, opts, t0 + 31 * 60_000)).toBe('full');
  });

  it('una ejecución interrumpida se marca como fallida al arrancar si nadie tiene el bloqueo', () => {
    const store = new Store(openDatabase(':memory:'));
    const id = store.startRun('full', 1000);
    expect(store.acquireLock('sync', 'vivo', 60_000, 1000)).toBe(true);
    store.failStaleRuns(2000);
    expect(store.recentRuns(1)[0]!.status).toBe('running');
    store.releaseLock('sync', 'vivo');
    store.failStaleRuns(3000);
    expect(store.recentRuns(1)[0]).toMatchObject({ id, status: 'failed' });
  });

  it('el bloqueo caduca si su dueño desaparece', () => {
    const store = new Store(openDatabase(':memory:'));
    expect(store.acquireLock('sync', 'a', 1000, 0)).toBe(true);
    expect(store.acquireLock('sync', 'b', 1000, 500)).toBe(false);
    expect(store.acquireLock('sync', 'b', 1000, 1500)).toBe(true);
  });
});

describe('utilidades', () => {
  it('LRU con caducidad y expulsión', () => {
    let now = 0;
    const c = new LruCache<number>(2, 100, () => now);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    now = 200;
    expect(c.get('a')).toBeUndefined();
  });

  it('el limitador respeta la simultaneidad máxima', async () => {
    const lim = new RateLimiter(0, 2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => lim.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    })));
    expect(peak).toBe(2);
  });

  it('el limitador espaciará las peticiones según maxRps', async () => {
    let now = 0;
    const waits: number[] = [];
    const lim = new RateLimiter(10, 5, () => now, async (ms) => { waits.push(ms); now += ms; });
    for (let i = 0; i < 3; i++) await lim.run(async () => {});
    expect(now).toBe(200);
    lim.pause(1000);
    await lim.run(async () => {});
    expect(now).toBeGreaterThanOrEqual(1200);
  });
});
