type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env['LOG_LEVEL'] as Level) ?? 'info'] ?? ORDER.info;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, extra);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

export type Logger = ReturnType<typeof logger>;
