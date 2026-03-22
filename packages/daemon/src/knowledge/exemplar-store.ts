// src/knowledge/exemplar-store.ts
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import type { Exemplar } from '../types.js';

export class ExemplarStore {
  constructor(private path: string) {}

  async get(deliverableType: string): Promise<Exemplar | undefined> {
    const all = await this.loadAll();
    return all[deliverableType];
  }

  async store(exemplar: Exemplar): Promise<boolean> {
    const all = await this.loadAll();
    const existing = all[exemplar.deliverableType];
    if (existing && existing.qualityScore >= exemplar.qualityScore) {
      return false;
    }
    all[exemplar.deliverableType] = exemplar;
    await writeJsonSafe(this.path, all);
    return true;
  }

  async list(): Promise<Record<string, Exemplar>> {
    return this.loadAll();
  }

  private async loadAll(): Promise<Record<string, Exemplar>> {
    const result = await readJsonSafe<Record<string, Exemplar>>(this.path);
    return result.ok ? result.value : {};
  }
}
