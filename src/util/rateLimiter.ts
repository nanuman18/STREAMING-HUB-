/**
 * Limita simultaneidad y ritmo (peticiones/segundo) de una función asíncrona.
 * Además permite pausar todas las peticiones cuando TMDB responde 429 con Retry-After.
 */
export class RateLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private nextSlot = 0;
  private pausedUntil = 0;

  constructor(
    private readonly maxRps: number,
    private readonly concurrency: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Detiene el envío de nuevas peticiones durante `ms` milisegundos. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.waitForSlot();
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => { this.active++; resolve(); }));
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }

  private async waitForSlot(): Promise<void> {
    const interval = this.maxRps > 0 ? 1000 / this.maxRps : 0;
    for (;;) {
      const now = this.now();
      const start = Math.max(now, this.nextSlot, this.pausedUntil);
      if (start <= now) {
        this.nextSlot = now + interval;
        return;
      }
      await this.sleep(start - now);
    }
  }
}
