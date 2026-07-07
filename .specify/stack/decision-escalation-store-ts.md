---
id: STACK-AC-DECISION-ESCALATION-STORE
type: stack-specific
domain: runforge
status: draft
version: 2
layer: 3
stack: typescript
references: ARCH-AC-DECISION-ESCALATION
code_paths:
  - packages/decision-protocol/
  - packages/decision-index/
  - packages/sanitizer-redaction/src/protected-store.ts
  - packages/sanitizer-redaction/src/schema.ts
test_paths:
  - packages/decision-protocol/**/*.test.ts
  - packages/decision-index/**/*.test.ts
  - packages/sanitizer-redaction/**/*.test.ts
---

# STACK-AC-DECISION-ESCALATION-STORE — Decision Store & Protocol (TypeScript)

## Pattern

**Fold the proven cockpit consumer's `protocol` + `index` packages in as the Decision Store — port, do not rewrite.** These packages already implement exactly the L2's data model and lifecycle: the `DecisionRequest`/`DecisionResponse`/`SensitivePayload` contracts, the §6.2 status machine as an explicit transition table, transition-key idempotency, and a **two-phase outbox** with deterministic, probeable effect IDs. They carry 270+ unit tests plus a live real-GitHub e2e, so the win is reuse, not reinvention. They move into runforge's monorepo as `packages/decision-protocol` and `packages/decision-index`, keeping their internal contracts intact.

The durability spine is **deterministic effect IDs reconstructable from item state without the outbox row** — `effectId = <decision_id>:<kind>:<semantic_key>` — so a crash between *execute* and *commit* is recoverable by probing the downstream with the same id rather than trusting a persisted flag. State is always re-derivable from the store; `reconcile()` is the single recovery path.

## Key Decisions

- **Drizzle ORM over Postgres (postgres-js), dedicated `decision_index` schema, single-writer** — the store now reuses the daemon's existing Postgres (`RUNFORGE_DATABASE_URL`) instead of a `better-sqlite3` file, so a fresh environment with no native module can always run the index. WAL maps to Postgres **MVCC**; FKs are native. All tables live in a `pgSchema('decision_index')` namespace, hard-isolated from `packages/db`'s `public` tables. ISO-8601 timestamps stay `text()` (zero behavioral drift). The single-writer discipline is what makes the CAS claim sound. Status/events stay string-union types, not a state-machine library.
- **CAS claim by affected-row COUNT (atomic `UPDATE … WHERE state='reserved' RETURNING`)** — the win is decided by `claimed.length === 1`, NOT a read-before/read-after (which is **unsound** on concurrent Postgres under READ COMMITTED — both claimers could re-read `executing` and both return true). The conditional UPDATE's row-lock + predicate re-check guarantees exactly one match. The owner-generation token + `claimLeaseMs` (default 30s) reconcile logic is preserved verbatim — `reconcile()` re-claims an `executing` row only once its claim is older than the lease AND owned by a prior generation.
- **Cross-process single-writer = a per-write-transaction `pg_try_advisory_xact_lock(K)`** (`K = hashtext('runforge:decision-index:writer')`). The first statement of every write tx takes the xact-lock and **checks the boolean** (`false` ⇒ throw + abort). A tx-scoped lock holds no session state, so it is immune to postgres-js transparent reconnects and auto-releases at tx end — it is the **sole authoritative** guarantee. The boot `pg_try_advisory_lock(K)` is a NON-holding fast-fail (acquire-then-immediately-release) — a cheap "two daemons, one DB" early alarm only, never a lifetime-held session lock.
- **Re-entrant in-process writer mutex over a `max:1` connection** — preserves better-sqlite3's serial-writer semantics (no interleaving at `await` points). The mutex MUST be re-entrant: `outbox.commit() → apply() → withTx` nests, so an `AsyncLocalStorage` "current writer tx" context reuses the open tx (flatten, not savepoint) rather than deadlocking. `max:1` + disabled recycling keep reconnects rare.
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

- **Never decide the CAS winner by re-reading state — use the affected-row count.** A read-before/read-after claim is unsound on concurrent Postgres connections (both claimers can observe `executing` and both "win"). Decide on `UPDATE … WHERE state='reserved' RETURNING` row count.
- **Single-writer is enforced by a per-transaction advisory xact-lock, not a session lock.** A session-scoped `pg_advisory_lock` dies silently on a postgres-js transparent reconnect (idle timeout / server restart / blip) while the writer object keeps running. Take `pg_try_advisory_xact_lock(K)` as the first statement of every write tx and **check its boolean result** — do not fire-and-forget. One writer process per database; the boot session-lock check is only a non-holding fast-fail.
- **EVERY mutation must go through the guarded `withTx` primitive — no bare `db.insert().run()`.** On sqlite the single connection serialized even bare writes; on Postgres a bare write outside `withTx` holds neither the writer mutex nor the per-tx advisory lock, defeating both guarantees. Wrap `admit`/`observeRequest`/`setWorkerSession`/`reveal`-audit/quarantine `record`/protected `put` in `withTx`. Reads (`select`) stay outside.
- **The writer mutex must be re-entrant.** `commit() → apply()` opens a nested `withTx`; a naive FIFO mutex deadlocks on re-entry. An `AsyncLocalStorage` tx context flattens the inner call onto the outer tx (matching the documented "run apply in the same outer txn" intent), acquiring the mutex exactly once at the outermost entry.
- **Timestamps stay ISO-8601 `text`.** All time fields are written via `clock().toISOString()` and compared lexically / parsed with `new Date(...)`; keeping them `text` (not `timestamptz`) is zero-drift. A `timestamptz` migration is explicitly out of scope.
- **Greenfield cutover is a file-existence check + ack env — the runtime NEVER opens the sqlite file.** Boot aborts if a legacy `decision-index.sqlite` exists and `RUNFORGE_DECISION_INDEX_CUTOVER_ACK` is unset (it may hold unanswered escalations). The check is pure `fs.existsSync` — opening the file would reintroduce the very `better-sqlite3` native dep the migration removes. Row salvage is a separate optional operator tool (the only place `better-sqlite3` may survive).
- **Back up Postgres AND `protectedDir` together.** Only the `protected_refs` *pointer* rows live in Postgres; the encrypted `<dir>/<ulid>.enc` blob bodies stay on the filesystem. Losing the blobs makes refs un-revealable. `protected_refs` is one physical table (`decision_index.protected_refs`) with two drizzle defs — the decision-index migration owns it; `sanitizer-redaction` accesses it through the shared writer connection (its `put` routes through the injected guarded `withTx`).
- **Answer-from-`notified` is illegal.** The lifecycle requires `notified → opened → viewed` before `answer_submitted`; answering a still-`notified` item must auto-apply `opened` first. This bug passed 270 unit tests + 5 review rounds and was only caught by live e2e — keep the e2e.
- **Reconcile must defer on a *fresh* claim.** Re-claim only `executing` rows older than the claim-lease; a fresher claim is a live in-flight execution — stealing it double-executes the effect.
- **The deterministic effect id is the only crash-recovery key.** Never make recovery depend on the outbox row existing; always probe the downstream by reconstructed id.
- **Port the packages whole.** Resist "cleaning up" the contracts during the fold — their shape is what the 270+ tests and the dashboard/watcher consumers depend on; rename the package, keep the surface.
