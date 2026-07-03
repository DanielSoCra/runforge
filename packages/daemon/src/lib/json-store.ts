// src/lib/json-store.ts
import { writeFile, rename, readFile, appendFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { ok, err, type Result } from './result.js';

// pid+timestamp alone can collide for two same-process writes in the same
// millisecond (concurrent HTTP handlers) — the random suffix makes each
// atomic write's temp file unique.
export async function writeJsonSafe<T>(path: string, data: T): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

export async function writeTextSafe(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export async function readJsonSafe<T>(path: string): Promise<Result<T>> {
  try {
    const raw = await readFile(path, 'utf-8');
    return ok(JSON.parse(raw) as T);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

export async function appendJsonl<T>(path: string, entry: T): Promise<void> {
  await appendFile(path, JSON.stringify(entry) + '\n');
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
