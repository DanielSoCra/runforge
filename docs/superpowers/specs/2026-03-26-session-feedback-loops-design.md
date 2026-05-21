# Session Feedback Loops Design

> Detect failing session patterns and adapt automatically — escalate models, then alert humans.

**Goal:** Stop wasting runs on silently failing sessions by tracking outcomes per session type and auto-escalating the model when patterns emerge.

**Architecture:** A `SessionTracker` in the session runtime records outcomes in a ring buffer. When consecutive failures are detected, it overrides the session's model to the next tier. When escalation is exhausted, it alerts via GitHub comment. Session outcomes are also logged to Supabase for historical analysis.

---

## Session Tracker

### Data Model

```typescript
interface SessionOutcome {
  sessionType: SessionType;
  model: string;           // model actually used (after any escalation)
  durationMs: number;
  exitStatus: ExitStatus;  // 'success' | 'failed' | 'timed-out'
  cost: number;
  empty: boolean;          // output was empty or cost === 0
  timestamp: number;
}
```

In-memory ring buffer: last 20 outcomes per session type. Resets on daemon restart (same pattern as retry backoff — restart is itself a form of reset).

### Detection Rules

**Silent failure** (per-session): `cost === 0 || exitStatus === 'failed' || empty === true`

**Failing pattern** (triggers escalation): 2+ consecutive failures for the same session type.

**Chronic failure** (triggers alert): 3+ consecutive failures after model has been escalated to the highest available tier.

**Reset**: any successful session outcome resets the failure counter for that session type.

### Model Escalation Ladder

```
haiku  → sonnet → opus → ALERT (no further escalation)
sonnet → opus   → ALERT
opus   → ALERT  (already at top)
```

The base model comes from `AgentDefinition.modelOverride`. Escalation goes up from there. When `getEffectiveModel(def)` is called, it checks the failure count and returns the escalated model if a pattern is detected.

Escalation is per session type, not per issue. If `classifier` (haiku) fails twice, all future classifier sessions use sonnet until a success resets it.

### Alert Mechanism

When chronic failure is detected (escalation exhausted + still failing), fire a callback:
- Post a GitHub comment on the active issue: `"Session type '{type}' has failed {N} consecutive times (tried models: haiku → sonnet → opus). Needs human investigation."`
- Log a warning: `[session-tracker] Chronic failure for {type} — {N} consecutive failures, escalation exhausted`

The alert callback is injected into `SessionTracker` at construction, keeping the tracker decoupled from GitHub/Octokit.

---

## Integration Point

The tracker wraps `spawnSession` in `SessionRuntime` — no changes to handlers or pipeline.

```typescript
// In SessionRuntime.spawnSession():

// 1. Check for model escalation
const effectiveModel = this.tracker.getEffectiveModel(def);
const effectiveDef = effectiveModel !== def.modelOverride
  ? { ...def, modelOverride: effectiveModel }
  : def;

// 2. Spawn session (existing code)
const startTime = Date.now();
const result = await this.adapter.spawn(effectiveDef, prompt, options);

// 3. Record outcome
this.tracker.record({
  sessionType: type,
  model: effectiveDef.modelOverride ?? 'default',
  durationMs: Date.now() - startTime,
  exitStatus: result.ok ? result.value.exitStatus : 'failed',
  cost: result.ok ? result.value.cost : 0,
  empty: result.ok ? (!result.value.output || result.value.cost === 0) : true,
  timestamp: Date.now(),
});

// 4. Alert on chronic failure
if (this.tracker.isChronicFailure(type)) {
  await this.alertCallback?.(type, issueNumber);
}
```

The tracker is instantiated in `SessionRuntime` constructor. The alert callback is wired in `daemon.ts` where Octokit is available.

---

## DB Logging

Add 3 nullable columns to the existing `sessions` table insert in `run-writer.ts`:

| Column | Type | Description |
|--------|------|-------------|
| `duration_ms` | `INTEGER` | Wall-clock session duration |
| `exit_status` | `TEXT` | `'success'`, `'failed'`, `'timed-out'` |
| `model_used` | `TEXT` | Actual model used (after escalation) |

Supabase migration adds these as nullable columns — no breaking change to existing rows.

Data flows: `spawnSession` → adapter returns result → `SessionTracker.record()` saves in-memory → `runWriter.logSession()` saves to DB with the new fields.

This enables future queries:
- p95 session duration per type (for timeout tuning)
- Success rate per model per session type (for routing validation)
- Cost per session type (for budget optimization)

---

## Files

| File | Change |
|------|--------|
| `packages/daemon/src/session-runtime/session-tracker.ts` | **New** — SessionTracker class (~80 lines) |
| `packages/daemon/src/session-runtime/runtime.ts` | Integrate tracker in `spawnSession` |
| `packages/daemon/src/supabase/run-writer.ts` | Add duration/status/model to session insert |
| `supabase/migrations/NNN_session_feedback.sql` | Add 3 nullable columns |
| `packages/daemon/src/session-runtime/session-tracker.test.ts` | **New** — unit tests |

---

## Testing

- **Record + detect**: record 2 failures → `isFailingPattern` returns true
- **Escalation**: haiku session fails 2x → `getEffectiveModel` returns sonnet
- **Double escalation**: sonnet also fails 2x → returns opus
- **Chronic failure**: opus fails 3x → `isChronicFailure` returns true
- **Reset**: failure streak then 1 success → counters reset, model returns to base
- **Independence**: failures in `classifier` don't affect `worker`
- **Ring buffer**: buffer doesn't grow unbounded (capped at 20 per type)

---

## Out of Scope

- Cross-restart persistence (in-memory is sufficient — restart resets patterns)
- Prompt adaptation (changing prompts based on failure patterns — future work)
- Parallel exploration (spawning multiple workers — separate design)
- Dashboard visualization of session analytics (future — data is in DB for when we want it)
