/**
 * Compute a human-readable duration from a timestamp to now.
 * Examples: "<1m", "30m", "2h", "3d"
 */
export function formatDuration(start: string): string {
  const ms = Date.now() - new Date(start).getTime();
  const minutes = Math.floor(ms / (1000 * 60));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
