/**
 * Timestamped logger. All output is prefixed with [HH:MM].
 */

type LogLevel = 'info' | 'warn' | 'error';

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `[${hh}:${mm}]`;
}

export function log(level: LogLevel, message: string): void {
  const prefix = `${timestamp()} [${level.toUpperCase()}]`;
  switch (level) {
    case 'error':
      console.error(`${prefix} ${message}`);
      break;
    case 'warn':
      console.warn(`${prefix} ${message}`);
      break;
    default:
      console.log(`${prefix} ${message}`);
  }
}
