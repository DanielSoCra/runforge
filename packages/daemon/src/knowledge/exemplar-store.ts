// src/knowledge/exemplar-store.ts
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import type { Exemplar } from '../types.js';

export class ExemplarStore {
  /** Promise-based mutex — serializes the read-modify-write in store() so a
   *  lower-quality exemplar cannot clobber a concurrent higher-quality write
   *  (#297). Same pattern as GotchaStore (#295). */
  private mutex: Promise<void> = Promise.resolve();

  constructor(private path: string) {}

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const prev = this.mutex;
    this.mutex = gate;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async get(deliverableType: string): Promise<Exemplar | undefined> {
    const all = await this.loadAll();
    return all[deliverableType];
  }

  async store(exemplar: Exemplar): Promise<boolean> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const existing = all[exemplar.deliverableType];
      if (existing && existing.qualityScore >= exemplar.qualityScore) {
        return false;
      }
      all[exemplar.deliverableType] = exemplar;
      await writeJsonSafe(this.path, all);
      return true;
    });
  }

  async list(): Promise<Record<string, Exemplar>> {
    return this.loadAll();
  }

  private async loadAll(): Promise<Record<string, Exemplar>> {
    const result = await readJsonSafe<Record<string, Exemplar>>(this.path);
    return result.ok ? result.value : {};
  }
}
