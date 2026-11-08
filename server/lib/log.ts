type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.LOG_LEVEL as Level) || (process.env.NODE_ENV === 'test' ? 'warn' : 'info');
const json = process.env.NODE_ENV === 'production';

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < order[minLevel]) return;
  if (json) {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  } else {
    const extra = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    (level === 'error' ? console.error : console.log)(`[${level}] ${msg}${extra}`);
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
