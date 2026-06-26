// packages/daemon/src/coordination/product-owner/shared-po-state.ts
//
// SharedPOState persistence with optimistic concurrency and merge-on-conflict.

import { readJsonSafe, writeJsonSafe } from '../../lib/json-store.js';
import { type SharedPOState, SharedPOStateSchema, type NeedsDiscussionItem, type AutonomousDecisionRecord } from './interactive-schemas.js';

export type SharedPOStateError = 'version_conflict' | 'io_error';

export interface WriteResult {
  ok: boolean;
  error?: SharedPOStateError;
}

function emptyState(): SharedPOState {
  return {
    needsDiscussion: [],
    autonomousDecisions: [],
    triageQueue: [],
    version: 0,
    lastUpdated: new Date().toISOString(),
  };
}

export class SharedPOStateStore {
  constructor(private readonly path: string, private readonly maxRetries = 3) {}

  async read(): Promise<SharedPOState> {
    const result = await readJsonSafe<SharedPOState>(this.path);
    if (!result.ok) {
      return emptyState();
    }
    const parsed = SharedPOStateSchema.safeParse(result.value);
    if (!parsed.success) {
      return emptyState();
    }
    return parsed.data;
  }

  async write(state: SharedPOState, expectedVersion: number): Promise<WriteResult> {
    try {
      const current = await this.read();
      if (current.version !== expectedVersion) {
        return { ok: false, error: 'version_conflict' };
      }
      const toWrite: SharedPOState = {
        ...state,
        version: expectedVersion + 1,
        lastUpdated: new Date().toISOString(),
      };
      await writeJsonSafe(this.path, toWrite);
      return { ok: true };
    } catch (e) {
      console.warn(
        `[shared-po-state] write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, error: 'io_error' };
    }
  }

  async writeWithRetry(
    state: SharedPOState,
    expectedVersion: number,
  ): Promise<WriteResult> {
    let lastResult: WriteResult = { ok: false, error: 'version_conflict' };
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      lastResult = await this.write(state, expectedVersion);
      if (lastResult.ok) return lastResult;
      if (lastResult.error === 'version_conflict') {
        const fresh = await this.read();
        const merged = mergeInteractiveDecisions(fresh, state);
        expectedVersion = fresh.version;
        state = merged;
      } else {
        return lastResult;
      }
    }
    return lastResult;
  }
}

export function markItemDecided(
  state: SharedPOState,
  itemId: string,
  decision: string,
): SharedPOState {
  const now = new Date().toISOString();
  return {
    ...state,
    needsDiscussion: state.needsDiscussion.map((item) =>
      item.id === itemId
        ? {
            ...item,
            status: 'decided' as const,
            operatorDecision: decision,
            decisionTimestamp: now,
          }
        : item,
    ),
    lastUpdated: now,
  };
}

export function markDecisionReviewed(
  state: SharedPOState,
  decisionId: string,
): SharedPOState {
  const now = new Date().toISOString();
  return {
    ...state,
    autonomousDecisions: state.autonomousDecisions.map((decision) =>
      decision.id === decisionId ? { ...decision, reviewed: true } : decision,
    ),
    lastUpdated: now,
  };
}

export function addNeedsDiscussionItems(
  state: SharedPOState,
  items: NeedsDiscussionItem[],
): SharedPOState {
  const existingIds = new Set(state.needsDiscussion.map((i) => i.id));
  const newItems = items.filter((i) => !existingIds.has(i.id));
  return {
    ...state,
    needsDiscussion: [...state.needsDiscussion, ...newItems],
    lastUpdated: new Date().toISOString(),
  };
}

export function addAutonomousDecisions(
  state: SharedPOState,
  decisions: AutonomousDecisionRecord[],
): SharedPOState {
  const existingIds = new Set(state.autonomousDecisions.map((d) => d.id));
  const newDecisions = decisions.filter((d) => !existingIds.has(d.id));
  return {
    ...state,
    autonomousDecisions: [...state.autonomousDecisions, ...newDecisions],
    lastUpdated: new Date().toISOString(),
  };
}

export function mergeInteractiveDecisions(
  base: SharedPOState,
  incoming: SharedPOState,
): SharedPOState {
  // Re-apply interactive decisions (status changes, reviewed flags) onto fresh base.
  // Autonomous additions are additive-only and handled by add* helpers.
  let merged = addNeedsDiscussionItems(base, incoming.needsDiscussion);
  merged = addAutonomousDecisions(merged, incoming.autonomousDecisions);

  for (const item of incoming.needsDiscussion) {
    if (item.status !== 'pending' || item.operatorDecision !== null) {
      merged = markItemDecided(merged, item.id, item.operatorDecision ?? 'decided');
    }
  }

  for (const decision of incoming.autonomousDecisions) {
    if (decision.reviewed) {
      merged = markDecisionReviewed(merged, decision.id);
    }
  }

  return merged;
}
