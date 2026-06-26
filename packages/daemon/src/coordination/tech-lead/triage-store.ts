// packages/daemon/src/coordination/tech-lead/triage-store.ts
//
// Daily triage cap persisted as a single JSON file with date-keyed reset.

import { readJsonSafe, writeJsonSafe } from '../../lib/json-store.js';

export interface TriageState {
  date: string;
  approvedCount: number;
}

const DEFAULT_CAP = 5;

export class TriageStore {
  constructor(private readonly path: string) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async load(): Promise<TriageState> {
    const result = await readJsonSafe<TriageState>(this.path);
    if (!result.ok) {
      return { date: this.today(), approvedCount: 0 };
    }
    const state = result.value;
    if (state.date !== this.today()) {
      return { date: this.today(), approvedCount: 0 };
    }
    return state;
  }

  async remaining(cap: number = DEFAULT_CAP): Promise<number> {
    const state = await this.load();
    return Math.max(0, cap - state.approvedCount);
  }

  async increment(count = 1): Promise<void> {
    const state = await this.load();
    await writeJsonSafe(this.path, {
      date: this.today(),
      approvedCount: state.approvedCount + count,
    });
  }
}
