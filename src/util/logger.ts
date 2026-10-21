const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let current: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const extra = data && Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  (level === 'error' || level === 'warn' ? console.error : console.log)(line + extra);
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit('debug', scope, m, d),
    info: (m, d) => emit('info', scope, m, d),
    warn: (m, d) => emit('warn', scope, m, d),
    error: (m, d) => emit('error', scope, m, d),
  };
}
