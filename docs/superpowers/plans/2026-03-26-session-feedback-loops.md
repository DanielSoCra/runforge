# Session Feedback Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect failing session patterns and auto-escalate models, then alert humans when escalation is exhausted.

**Architecture:** New `SessionTracker` class with in-memory ring buffer. Wraps the existing `spawnSession` flow — no handler or pipeline changes. DB logging extends the existing `cost_events` table with 3 new columns.

**Tech Stack:** TypeScript, Vitest, Supabase

**Spec:** `docs/superpowers/specs/2026-03-26-session-feedback-loops-design.md`

---

### Task 1: SessionTracker class

Create the tracker with ring buffer, pattern detection, model escalation, and chronic failure detection.

**Files:**
- Create: `packages/daemon/src/session-runtime/session-tracker.ts`
- Create: `packages/daemon/src/session-runtime/session-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTracker } from './session-tracker.js';

describe('SessionTracker', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  describe('pattern detection', () => {
    it('no failing pattern when no history', () => {
      expect(tracker.isFailingPattern('classifier')).toBe(false);
    });

    it('no failing pattern after 1 failure', () => {
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.isFailingPattern('classifier')).toBe(false);
    });

    it('detects failing pattern after 2 consecutive failures', () => {
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.isFailingPattern('classifier')).toBe(true);
    });

    it('resets after success', () => {
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 500, exitStatus: 'completed', cost: 0.05, empty: false, timestamp: Date.now() });
      expect(tracker.isFailingPattern('classifier')).toBe(false);
    });

    it('treats empty output as failure', () => {
      tracker.record({ sessionType: 'worker', model: 'sonnet', durationMs: 100, exitStatus: 'completed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'worker', model: 'sonnet', durationMs: 100, exitStatus: 'completed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.isFailingPattern('worker')).toBe(true);
    });

    it('session types are independent', () => {
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'haiku', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.isFailingPattern('classifier')).toBe(true);
      expect(tracker.isFailingPattern('worker')).toBe(false);
    });
  });

  describe('model escalation', () => {
    it('returns base model when no failures', () => {
      expect(tracker.getEffectiveModel({ modelOverride: 'claude-haiku-4-5-20251001' } as any)).toBe('claude-haiku-4-5-20251001');
    });

    it('escalates haiku to sonnet after failing pattern', () => {
      tracker.record({ sessionType: 'classifier', model: 'claude-haiku-4-5-20251001', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'claude-haiku-4-5-20251001', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.getEffectiveModel({ name: 'classifier', modelOverride: 'claude-haiku-4-5-20251001' } as any)).toBe('claude-sonnet-4-6');
    });

    it('escalates sonnet to opus after continued failures', () => {
      // 2 haiku failures → escalate to sonnet
      tracker.record({ sessionType: 'classifier', model: 'claude-haiku-4-5-20251001', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'claude-haiku-4-5-20251001', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      // 2 sonnet failures → escalate to opus
      tracker.record({ sessionType: 'classifier', model: 'claude-sonnet-4-6', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'claude-sonnet-4-6', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.getEffectiveModel({ name: 'classifier', modelOverride: 'claude-haiku-4-5-20251001' } as any)).toBe('claude-opus-4-6');
    });

    it('returns undefined (user default) when no modelOverride set', () => {
      expect(tracker.getEffectiveModel({ name: 'worker' } as any)).toBeUndefined();
    });
  });

  describe('chronic failure', () => {
    it('not chronic after escalation with failures', () => {
      // 2 haiku failures
      tracker.record({ sessionType: 'classifier', model: 'claude-haiku-4-5-20251001', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      tracker.record({ sessionType: 'classifier', model: 'claude-haiku-4-5-20251001', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.isChronicFailure('classifier')).toBe(false);
    });

    it('chronic when opus fails 3 times', () => {
      // Exhaust escalation ladder
      for (let i = 0; i < 2; i++) tracker.record({ sessionType: 'classifier', model: 'claude-haiku-4-5-20251001', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      for (let i = 0; i < 2; i++) tracker.record({ sessionType: 'classifier', model: 'claude-sonnet-4-6', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      for (let i = 0; i < 3; i++) tracker.record({ sessionType: 'classifier', model: 'claude-opus-4-6', durationMs: 100, exitStatus: 'failed', cost: 0, empty: true, timestamp: Date.now() });
      expect(tracker.isChronicFailure('classifier')).toBe(true);
    });
  });

  describe('ring buffer', () => {
    it('caps at 20 entries per session type', () => {
      for (let i = 0; i < 25; i++) {
        tracker.record({ sessionType: 'worker', model: 'sonnet', durationMs: 100, exitStatus: 'completed', cost: 0.1, empty: false, timestamp: Date.now() });
      }
      // Should not throw or grow unbounded — internal check
      expect(tracker.isFailingPattern('worker')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/session-runtime/session-tracker.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement SessionTracker**

Create `packages/daemon/src/session-runtime/session-tracker.ts`:

```typescript
import type { SessionType } from '../types.js';

export interface SessionOutcome {
  sessionType: SessionType;
  model: string;
  durationMs: number;
  exitStatus: string;
  cost: number;
  empty: boolean;
  timestamp: number;
}

const MODEL_LADDER: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'claude-sonnet-4-6',
  'claude-sonnet-4-6': 'claude-opus-4-6',
  // opus has no escalation — it's the top
};

const MAX_BUFFER_SIZE = 20;
const ESCALATION_THRESHOLD = 2; // consecutive failures before escalating
const CHRONIC_THRESHOLD = 3;    // consecutive failures at top tier before alerting

function isFailure(outcome: SessionOutcome): boolean {
  return outcome.empty || outcome.cost === 0 || outcome.exitStatus === 'failed' || outcome.exitStatus === 'timed-out';
}

export class SessionTracker {
  private buffers = new Map<string, SessionOutcome[]>();

  record(outcome: SessionOutcome): void {
    const key = outcome.sessionType;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = [];
      this.buffers.set(key, buffer);
    }
    buffer.push(outcome);
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  /** Count consecutive failures from the end of the buffer. */
  private consecutiveFailures(sessionType: string): number {
    const buffer = this.buffers.get(sessionType);
    if (!buffer || buffer.length === 0) return 0;
    let count = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (isFailure(buffer[i])) count++;
      else break;
    }
    return count;
  }

  /** True if 2+ consecutive failures for this session type. */
  isFailingPattern(sessionType: string): boolean {
    return this.consecutiveFailures(sessionType) >= ESCALATION_THRESHOLD;
  }

  /** True if escalation exhausted and still failing (3+ at top tier). */
  isChronicFailure(sessionType: string): boolean {
    const buffer = this.buffers.get(sessionType);
    if (!buffer) return false;
    const failures = this.consecutiveFailures(sessionType);
    if (failures < ESCALATION_THRESHOLD + CHRONIC_THRESHOLD) return false;
    // Check if the last CHRONIC_THRESHOLD failures are at the top tier (opus or no escalation available)
    const recent = buffer.slice(-CHRONIC_THRESHOLD);
    return recent.every(o => isFailure(o) && !MODEL_LADDER[o.model]);
  }

  /**
   * Returns the effective model for a session type based on failure history.
   * Escalates up the model ladder when failing patterns are detected.
   */
  getEffectiveModel(def: { name?: string; modelOverride?: string }): string | undefined {
    const sessionType = def.name ?? '';
    const baseModel = def.modelOverride;
    if (!baseModel) return undefined;

    const failures = this.consecutiveFailures(sessionType);
    if (failures < ESCALATION_THRESHOLD) return baseModel;

    // Walk up the ladder based on how many escalation rounds we've been through
    let model = baseModel;
    let escalations = Math.floor(failures / ESCALATION_THRESHOLD);
    while (escalations > 0 && MODEL_LADDER[model]) {
      model = MODEL_LADDER[model];
      escalations--;
    }
    return model;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/session-runtime/session-tracker.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/session-runtime/session-tracker.ts packages/daemon/src/session-runtime/session-tracker.test.ts
git commit -m "feat: add SessionTracker with pattern detection and model escalation"
```

---

### Task 2: Integrate tracker into SessionRuntime

Wire the tracker into `spawnSession` — model escalation, outcome recording, and chronic failure alert callback.

**Files:**
- Modify: `packages/daemon/src/session-runtime/runtime.ts:197-300`
- Modify: `packages/daemon/src/supabase/run-writer.ts:94-101`

- [ ] **Step 1: Add tracker to SessionRuntime constructor**

In `runtime.ts`, import `SessionTracker` and add it as a property:

```typescript
import { SessionTracker, type SessionOutcome } from './session-tracker.js';
```

Add to constructor:
```typescript
private tracker: SessionTracker;
private onChronicFailure?: (sessionType: SessionType, issueNumber: number) => Promise<void>;

constructor(config: Config, costTracker: CostTracker, rateLimiter?: RateLimiter, onChronicFailure?: (sessionType: SessionType, issueNumber: number) => Promise<void>) {
  // ... existing code ...
  this.tracker = new SessionTracker();
  this.onChronicFailure = onChronicFailure;
}
```

- [ ] **Step 2: Wire model escalation before spawn**

In `spawnSession`, before `this.adapter.spawn(def, ...)` (~line 262), add:

```typescript
// Model escalation based on session failure patterns
const effectiveModel = this.tracker.getEffectiveModel(def);
const effectiveDef = effectiveModel !== def.modelOverride
  ? { ...def, modelOverride: effectiveModel }
  : def;
if (effectiveModel !== def.modelOverride) {
  console.log(`[session-tracker] Escalated ${type} from ${def.modelOverride} to ${effectiveModel}`);
}
```

Replace `def` with `effectiveDef` in the `this.adapter.spawn()` call.

- [ ] **Step 3: Record outcome after spawn**

After the cost recording block (~line 281), add:

```typescript
// Record session outcome for pattern detection
const startTime = this.lastSpawnTime; // captured at step 4
this.tracker.record({
  sessionType: type,
  model: effectiveDef.modelOverride ?? 'default',
  durationMs: Date.now() - startTime,
  exitStatus: result.ok ? result.value.exitStatus : 'failed',
  cost,
  empty: result.ok ? (!result.value.output || cost === 0) : true,
  timestamp: Date.now(),
});

// Alert on chronic failure
if (this.tracker.isChronicFailure(type) && this.onChronicFailure) {
  void this.onChronicFailure(type, issueNumber);
}
```

- [ ] **Step 4: Extend DB logging with duration, status, model**

In `run-writer.ts`, update `writeCostEvent` to accept and log the extra fields:

```typescript
async writeCostEvent(
  runId: string,
  sessionType: SessionType,
  cost: number,
  extra?: { durationMs?: number; exitStatus?: string; modelUsed?: string },
): Promise<void> {
  const { error } = await this.supabase
    .from('cost_events')
    .insert({
      run_id: runId,
      session_type: toDbSessionType(sessionType),
      cost,
      duration_ms: extra?.durationMs,
      exit_status: extra?.exitStatus,
      model_used: extra?.modelUsed,
    });
  if (error) {
    console.warn(`[run-writer] writeCostEvent failed for ${runId}:`, error.message);
  }
}
```

Update the call site in `runtime.ts` to pass the extra fields.

- [ ] **Step 5: Wire alert callback in daemon.ts**

In `daemon.ts` where `SessionRuntime` is constructed, pass the chronic failure callback:

```typescript
const runtime = new SessionRuntime(config, costTracker, undefined, async (sessionType, issueNumber) => {
  console.warn(`[daemon] Chronic session failure: ${sessionType} for #${issueNumber}`);
  try {
    await octokit.issues.createComment({
      owner, repo: repoName, issue_number: issueNumber,
      body: `⚠️ **Session failure alert**: \`${sessionType}\` has failed multiple consecutive times with model escalation exhausted. Needs human investigation.`,
    });
  } catch (e) {
    console.error('[daemon] Failed to post chronic failure alert:', e);
  }
});
```

- [ ] **Step 6: Run tests**

Run: `cd packages/daemon && npx tsc --noEmit && npx vitest run`
Expected: ALL PASS (2068+ tests)

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/session-runtime/runtime.ts packages/daemon/src/supabase/run-writer.ts packages/daemon/src/control-plane/daemon.ts
git commit -m "feat: integrate session tracker — model escalation, outcome recording, chronic alerts"
```

---

### Task 3: DB migration + /status endpoint update

Add the 3 nullable columns to `cost_events` and expose tracker state in `/status`.

**Files:**
- Create: `supabase/migrations/NNN_session_feedback.sql`
- Modify: `packages/daemon/src/control-plane/daemon.ts` (status handler)

- [ ] **Step 1: Create migration**

Check the latest migration number:
```bash
ls supabase/migrations/ | tail -3
```

Create `supabase/migrations/012_session_feedback.sql` (adjust number):

```sql
-- Session feedback: track duration, exit status, and model per session
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS exit_status TEXT;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS model_used TEXT;
```

- [ ] **Step 2: Run migration**

```bash
# If using Supabase CLI:
npx supabase db push
# Or apply directly if remote:
# The columns are nullable so existing rows are unaffected
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat: add duration, exit_status, model_used to cost_events table"
```

---

### Execution Order

```
Task 1 (SessionTracker) ← standalone, no deps
  ↓
Task 2 (integration) ← depends on Task 1
  ↓
Task 3 (migration) ← independent but ships together
```

All 3 tasks can ship in one PR. Task 1 is self-contained and testable. Task 2 wires it in. Task 3 adds DB columns.
