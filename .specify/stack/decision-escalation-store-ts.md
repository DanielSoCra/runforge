---
id: STACK-AC-DECISION-ESCALATION-STORE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DECISION-ESCALATION
code_paths:
  - packages/decision-protocol/
  - packages/decision-index/
test_paths:
  - packages/decision-protocol/**/*.test.ts
  - packages/decision-index/**/*.test.ts
---

# STACK-AC-DECISION-ESCALATION-STORE — Decision Store & Protocol (TypeScript)

## Pattern

**Fold the proven pm-cockpit `protocol` + `index` packages in as the Decision Store — port, do not rewrite.** These packages already implement exactly the L2's data model and lifecycle: the `DecisionRequest`/`DecisionResponse`/`SensitivePayload` contracts, the §6.2 status machine as an explicit transition table, transition-key idempotency, and a **two-phase outbox** with deterministic, probeable effect IDs. They carry 270+ unit tests plus a live real-GitHub e2e, so the win is reuse, not reinvention. They move into auto-claude's monorepo as `packages/decision-protocol` (was `@pm/protocol`) and `packages/decision-index` (was `@pm/index`), keeping their internal contracts intact.

The durability spine is **deterministic effect IDs reconstructable from item state without the outbox row** — `effectId = <decision_id>:<kind>:<semantic_key>` — so a crash between *execute* and *commit* is recoverable by probing the downstream with the same id rather than trusting a persisted flag. State is always re-derivable from the store; `reconcile()` is the single recovery path.

## Key Decisions

- **Drizzle ORM over better-sqlite3 (WAL, single-writer)** — matches the daemon's existing data layer; the single-writer discipline is what makes the CAS claim sound. Status/events are string-union types enforced by TypeScript, not a state-machine library (the transition table is small enough to be a literal).
- **CAS claim with a process-generation token + claim-lease** — every `claim()` records a per-process generation id; `reconcile()` re-claims an `executing` row only once its claim is older than `claimLeaseMs` (default 30s), so a generic reconcile never steals a row a live `runEffect` is mid-execution.
- **Audit-only sub-steps** — `answering` and `validated` are recorded as `TransitionEvent`s in the audit log inside the single accepted `answer_submitted` transaction; they are **never** durable statuses. `stale` is a boolean flag on the item, never a status.
- **Sensitivity separation lives in `protocol/sensitivity.ts`** — confidential content is carried apart and never serialized into the shared item or its notifications.

## Examples

```ts
// transition_key keeps two transitions distinct by event even under a shared external key (§57)
export const transitionKey = (event: TransitionEvent, semanticKey: string) => `${event}:${semanticKey}`;

// deterministic, probeable effect id — reconstructable WITHOUT the outbox row → crash-recoverable
export const effectId = (decisionId: string, kind: EffectKind, semanticKey: string) =>
  `${decisionId}:${kind}:${semanticKey}`;

// durable statuses only (answering/validated are audit-only; stale is a flag)
const ITEM_STATUSES = ["detected","notified","viewed","answered_pending_source_write",
  "source_written","resume_requested","resumed","superseded","failed"] as const;
```

## Gotchas

- **Answer-from-`notified` is illegal.** The lifecycle requires `notified → opened → viewed` before `answer_submitted`; answering a still-`notified` item must auto-apply `opened` first. This bug passed 270 unit tests + 5 review rounds and was only caught by live e2e — keep the e2e.
- **Reconcile must defer on a *fresh* claim.** Re-claim only `executing` rows older than the claim-lease; a fresher claim is a live in-flight execution — stealing it double-executes the effect.
- **The deterministic effect id is the only crash-recovery key.** Never make recovery depend on the outbox row existing; always probe the downstream by reconstructed id.
- **Port the packages whole.** Resist "cleaning up" the contracts during the fold — their shape is what the 270+ tests and the dashboard/watcher consumers depend on; rename the package, keep the surface.
