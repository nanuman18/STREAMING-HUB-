import type { Store, SyncKind } from '../db/store.js';
import { createLogger } from '../util/logger.js';
import { SyncBusyError, type SyncService } from './service.js';

const log = createLogger('scheduler');

export interface ScheduleOptions {
  incrementalHours: number;
  fullHours: number;
  /** Espera mínima tras una sincronización fallida antes de reintentar. */
  failureBackoffMinutes?: number;
}

/** Decide qué sincronización toca ahora (o ninguna) a partir del historial guardado en la BD. */
export function dueSync(store: Store, opts: ScheduleOptions, now: number): SyncKind | null {
  const lastFailed = store.lastRun(undefined, ['failed']);
  const lastGood = store.lastRun(undefined, ['ok', 'partial']);
  const backoff = (opts.failureBackoffMinutes ?? 30) * 60_000;
  if (lastFailed && (!lastGood || lastFailed.started_at > lastGood.started_at) && now - lastFailed.started_at < backoff) return null;

  const lastFull = store.lastRun('full', ['ok', 'partial']);
  if (!lastFull || now - lastFull.started_at >= opts.fullHours * 3_600_000) return 'full';
  if (!lastGood || now - lastGood.started_at >= opts.incrementalHours * 3_600_000) return 'incremental';
  return null;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly sync: SyncService,
    private readonly opts: ScheduleOptions,
    private readonly tickMs = 5 * 60_000,
  ) {}

  start(initialDelayMs = 5_000): void {
    const loop = () => {
      void this.tick().finally(() => {
        this.timer = setTimeout(loop, this.tickMs);
        this.timer.unref();
      });
    };
    this.timer = setTimeout(loop, initialDelayMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.sync.isRunning) return;
    const kind = dueSync(this.store, this.opts, Date.now());
    if (!kind) return;
    try {
      await this.sync.run(kind);
    } catch (err) {
      if (err instanceof SyncBusyError) log.info('Sincronización omitida: ya hay otra en curso');
      else log.error('Error en la sincronización programada', { error: (err as Error).message });
    }
  }
}
