// src/control-plane/heartbeat.ts
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

/**
 * Starts a periodic heartbeat writer. Writes the current timestamp to `filePath`
 * every `intervalMs` milliseconds (and once immediately). Returns a stop function.
 */
export function startHeartbeat(filePath: string, intervalMs: number): () => void {
  const write = async () => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, new Date().toISOString().replace('T', ' ').slice(0, 19));
    } catch (e) {
      console.warn('[heartbeat] Failed to write heartbeat file:', e);
    }
  };

  // Write immediately, then on interval
  void write();
  const timer = setInterval(write, intervalMs);

  return () => clearInterval(timer);
}
