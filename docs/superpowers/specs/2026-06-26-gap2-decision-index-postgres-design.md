# Gap #2 — Decision-Index Postgres Migration (Design Spec)

- **Status:** draft (sparring planner output, codex-reviewed)
- **Issue:** #779 gap #2 ("escalation slice")
- **Scope:** migrate `packages/decision-index` (and the `protected_refs` pointer access in
  `packages/sanitizer-redaction`) from `better-sqlite3` to the daemon's existing Postgres data
  layer (`packages/db` style: drizzle + `postgres` / postgres-js). Spec + plan only; no code here.
- **Specs touched:** L3 `STACK-AC-DECISION-ESCALATION-STORE` (update, allowed). **No** L2/L1/L0
  change — `ARCH-AC-DECISION-ESCALATION` is store-agnostic (confirmed: it says "Decision Store",
  "single writer", "AppliedTransition", never sqlite/WAL).

---

## 1. Goal

Eliminate the `better-sqlite3` native dependency from the decision/escalation store by moving its
**relational metadata** onto the daemon's already-present Postgres, so that:

1. A fresh environment (no native module compiled) can **always** run the decision index — the
   dynamic-import / "broken native load → fail-closed-to-stuck" path disappears.
2. Escalations are **fail-closed-to-VISIBLE-escalated**, not fail-closed-to-invisible-stuck: an
   escalate/hold merge verdict raises and surfaces a durable `DecisionRequest` whenever the
   daemon's Postgres is reachable (which is mandatory for the daemon to run at all), instead of
   parking silently because the index is disabled/absent.
3. The system unifies its **relational** state on **one** store (Postgres). NOTE: this is "one
   relational metadata store," not literally one durable artifact — the encrypted protected
   **blob bodies** (`<dir>/<ulid>.enc`) deliberately stay on the filesystem (they are not in
   sqlite today either). Only the `protected_refs` *pointer* rows move to Postgres. **Operational
   consequence:** backup/restore must cover BOTH Postgres AND `protectedDir`; losing the blobs
   makes refs un-revealable. This is documented in the L3 gotchas.

Non-goals: rewriting the lifecycle/outbox/CAS semantics (port, don't redesign); moving the
encrypted protected **blob bodies** off disk (only the `protected_refs` *pointer table* moves);
changing the merge-decision risk gate; PHI/redaction feature work.

---

## 2. Current sqlite architecture (verified against code)

`packages/decision-index` is a single-writer, crash-safe decision store. Verified facts:

- **Connection model** (`src/db.ts`): `openDb()` opens one `better-sqlite3` handle, `PRAGMA
  journal_mode=WAL`, `PRAGMA foreign_keys=ON`. `openReadOnlyDb()` opens a `{ readonly: true }`
  handle that physically rejects writes at the sqlite layer. `withTx(db, fn)` wraps
  `client.transaction(() => fn(db))` — **synchronous**; "one connection == single writer."
- **Single-writer enforcement is by SURFACE** (`src/index.ts`): `openDb` is not exported; the only
  way to get a writer is `createIndexWriter()` (`src/index-writer.ts:92`), which opens the one
  writable handle internally, runs `migrate(db)`, builds the `ProtectedStore` + `SqliteQuarantine`
  over that same handle. Readers get `openReadOnlyDb()`.
- **Schema** (`src/schema.ts`, drizzle `sqlite-core`): `decisions` (PK `decision_id`),
  `decision_responses` (PK `decision_id` ⇒ answered-once), `applied_transitions`
  (PK `(decision_id, transition_key)` ⇒ idempotent transitions), `audit_log`
  (`integer autoIncrement` PK, append-only), `outbox` (PK deterministic `id`, two-phase:
  `state ∈ reserved|executing|committed|failed`, `claimed_at`/`claimed_by` lease+owner,
  `superseded` cancel-marker, `semantic_key`), `worker_sessions` (PK `decision_id`),
  `protected_refs` (PK `ulid`), `quarantine_events` (`integer autoIncrement` PK).
  Booleans are `integer({mode:"boolean"})`; all timestamps are ISO-8601 **text**.
- **Cross-package wrinkle:** `packages/sanitizer-redaction/src/protected-store.ts` ALSO holds a
  `BetterSQLite3Database` and does sync `.insert(protectedRefs)...run()` /
  `.select()...all()` (`put`, `findRefForField`, `metaOf`). It defines its OWN
  `protected_refs` (`sanitizer-redaction/src/schema.ts`) and writes through the **same** writable
  connection injected by `createIndexWriter`. The `.enc` blob bodies live on the filesystem
  (`<dir>/<ulid>.enc`) — **not** in the DB. `findRefForField`/`put` run **inside the synchronous
  ingest path** (`ingest()` → admit).
- **Sync drizzle surface to convert:** 57 `.run()/.all()/.get()` call sites across
  `outbox.ts` (33), `state-machine.ts` (8), `index-writer.ts` (7), `read-model.ts` (7),
  `audit-log.ts` (1), `quarantine.ts` (1) — plus the sanitizer-redaction protected-store
  (`put`/`findRefForField`/`metaOf`). 14 `withTx(...)` transaction call sites in `index-writer.ts`
  (1), `outbox.ts` (10), `state-machine.ts` (1) (+ the `db.ts` definition).
- **CAS single-writer claim** (`outbox.ts:294-310`, `claim()`): the current mapping is
  **read-before → conditional `UPDATE ... WHERE id=? AND state='reserved'` → read-after**, and it
  returns "I won" iff the after-read shows `executing`. **This is sound on sqlite only because the
  single connection serializes all writes** (the loser's UPDATE matches zero rows and never
  observes `reserved` after the winner committed). `reconcile()` uses an owner/generation token +
  `claimLeaseMs` (30s default) so a live in-flight claim is never stolen; a prior-generation
  claim past its lease is crash-recoverable.
- **Durability spine:** deterministic effect id `<decision_id>:<kind>:<semantic_key>` is
  reconstructable WITHOUT the outbox row; `reconcile()` probes the downstream by id (applied →
  commit/advance no re-dispatch; absent → re-execute; unknown → fail-closed terminal). `commit()`
  applies the transition AND marks the outbox row committed in ONE txn; terminal transitions
  cancel sibling reserved rows in the same txn (`state-machine.ts:516-521`).
- **Consumers** (`packages/daemon/src/control-plane/decision-escalation/`): `DecisionIndexManager`
  dynamic-imports the package only in its `enabled` branch (`manager.ts:61-83`) and fails closed
  (`#broken`) on import/open failure. `DecisionLedger` (`ledger.ts`) wraps the writer; its
  **synchronous** verbs (`raise→observeRequest`, `answer→applyEvent`, `supersede→applyEvent`,
  `expireOverdue→applyEvent` loop, `statusOf/pending/reader.*`) are called from `phases.ts:841,
  2177` (`ledger.raise`), `reconcile.ts:52,68`, `daemon.ts:1552-1553`, `decision-api.ts`.
- **Config gate** (`config.ts`): `RUNFORGE_DECISION_INDEX_ENABLED` default **false**;
  `RUNFORGE_DECISION_INDEX_PATH` (sqlite file), `_PROTECTED_DIR`, `_PROTECTED_KEY`.
- **Fail-closed-to-stuck path** (`phases.ts:828-862`): the L2-gate escalation block runs ONLY when
  `decisionManager?.isEnabled() === true`; a ledger throw leaves the run parked, block unpublished,
  no notify. When the flag is OFF the whole block is skipped — the run parks with a label/comment
  but **no surfaced DecisionRequest** (the gap-#2 failure).
- **Tests:** ~60 vitest files use `makeTempDb()` (`test/helpers/temp-db.ts`) — a real **on-disk**
  sqlite via `openDb` + `migrate`. `packages/db`'s own tests are pure unit tests (no live PG).

---

## 3. Target Postgres architecture

### 3.1 Connections & schema placement

- **Same database, dedicated schema.** Reuse `RUNFORGE_DATABASE_URL` (the daemon's existing
  Postgres — see `packages/db/src/env.ts`). Place all decision-index tables in a dedicated Postgres
  schema **`decision_index`** via `pgSchema('decision_index')`. Rationale: unify on one store (the
  goal) while keeping a hard namespace boundary from `packages/db`'s `public` tables (no collision
  today, but the boundary is defensive and makes the decision-index migrations independent).
- **Writer connection:** the decision-index keeps its OWN dedicated `postgres(url, { max: 1 })`
  connection (NOT the shared `getDbClient()` pool). One connection is required for the
  write-serialization to be stable. `createIndexWriter` opens it, runs the boot fast-fail check
  (§3.4 layer 1 — acquire-and-release, NON-holding), runs migrations, builds `ProtectedStore` +
  `Quarantine` over it. The single-writer guarantee is the **per-transaction** advisory xact-lock
  (§3.4 layer 2), NOT a lifetime-held session lock. `IndexWriter.close()` ends the connection (no
  session lock to release).
- **Reader connection:** `openReadOnlyDb()` becomes a small read-only postgres pool whose sessions
  are forced read-only (`options: '-c default_transaction_read_only=on'`, equivalently
  `postgres(url, { connection: { default_transaction_read_only: 'on' } })`). This reproduces
  sqlite's `{readonly:true}` "physically rejects writes" guarantee at the Postgres session level.
- **Why a dedicated writer connection rather than reusing the daemon pool:** the in-process write
  serialization wants a single stable backend (`max:1`, no recycling) so transactions truly
  serialize at the DB. Correctness does NOT depend on a held session lock (the per-tx xact-lock is
  reconnect-safe), but a dedicated non-rotating connection keeps the serial discipline simple.

### 3.2 Schema mapping (drizzle `pg-core`)

Mechanical, 1:1, no semantic change:

| sqlite (`sqlite-core`)                         | postgres (`pg-core`)                                              |
|------------------------------------------------|-------------------------------------------------------------------|
| `text(...).primaryKey()`                       | `text(...).primaryKey()` (ids/ulids/etags stay text — unchanged)  |
| `integer({mode:"boolean"})`                    | `boolean(...)` (`stale`, `pinned`, `muted`, `superseded`)         |
| `integer().primaryKey({autoIncrement:true})`  | `bigint(... ,{mode:'number'})` `generated always as identity` (`audit_log.id`, `quarantine_events.id`) |
| ISO-8601 timestamps stored as `text`           | **keep as `text`** (see note)                                     |
| `primaryKey({columns:[...]})` composite        | composite `primaryKey({columns:[...]})` — unchanged               |
| FK `.references(() => decisions.decision_id)`  | FK `.references(...)` — unchanged (Postgres enforces natively)    |

- **Timestamps stay `text`/ISO-8601.** All time fields are written via `clock().toISOString()` and
  compared as strings or parsed with `new Date(...)`. Keeping them `text` is the lowest-risk port
  (zero behavioral drift, no tz/precision surprises in lexical compares like
  `effectId`/audit ordering). A `timestamptz` migration is explicitly out of scope.
- **WAL + FK** map to Postgres natively (MVCC + declarative FKs); no pragma equivalent needed.
- **No sqlite-only features** are used (verified: no FTS5, no vector, no exotic pragmas) — nothing
  blocks the port.

### 3.3 Migrations

- Switch `packages/decision-index/drizzle.config.ts` to `dialect: 'postgresql'`, `out:
  './drizzle'` (mirroring `packages/db`). Regenerate ONE consolidated initial migration
  `drizzle/0000_init.sql` for the `decision_index` schema (the six incremental sqlite migrations
  `0000_init`…`0005_outbox_claimed_by` collapse into a single greenfield Postgres baseline — see
  §6 greenfield).
- Replace the bespoke `migrate.ts` (`client.exec` + "ignore already exists") with the standard
  drizzle postgres-js migrator (`drizzle-orm/postgres-js/migrator`, as `packages/db/src/migrate.ts`
  uses) so migration state is tracked in `decision_index.__drizzle_migrations` rather than
  swallowing errors. Migrations create the `decision_index` schema first
  (`CREATE SCHEMA IF NOT EXISTS decision_index`).

### 3.4 The CAS single-writer mapping — DECISION

**Chosen: rewrite `claim()` to a single atomic `UPDATE … RETURNING` and decide the winner by
affected-row count — NOT the current read-before/update/read-after.**

```ts
// claim(): won iff the conditional UPDATE actually flipped a row.
const claimed = await tx
  .update(outbox)
  .set({ state: 'executing', claimed_at: now, claimed_by: this.generation })
  .where(and(eq(outbox.id, id), eq(outbox.state, 'reserved')))
  .returning({ id: outbox.id });
return claimed.length === 1;
```

Justification: the existing read-before/read-after pattern is **unsound on concurrent Postgres
connections under READ COMMITTED** — two claimers can both read `reserved`, both issue the
conditional UPDATE (the loser blocks on the row lock, then re-checks the predicate against the
winner's committed row and updates 0 rows), and then both re-read `executing`, so BOTH would
return `true`. The affected-row-count form is atomic and correct under any isolation level because
the row-lock + predicate re-check guarantees exactly one UPDATE matches. This is the single most
important correctness change in the port. The owner-generation token + `claimLeaseMs` reconcile
logic (`executingIsReclaimable`) is preserved verbatim — it is orthogonal to how the win is decided.

**Cross-process single-writer (new, explicit) — reconnect-safe.** sqlite got "one writer" from the
surface gate + the one-daemon deployment assumption. On a shared network Postgres that assumption is
weaker, so single-writer is enforced with TWO layers (a session-level lock alone is unsafe because
postgres-js can transparently reconnect — idle timeout, server restart, network blip — and a new
backend session silently drops a session-scoped advisory lock while the writer object keeps running,
codex Important):

1. **Boot fast-fail (best-effort, NON-holding):** at `createIndexWriter`, `pg_try_advisory_lock(K)`
   where `K = hashtext('runforge:decision-index:writer')`, then **immediately
   `pg_advisory_unlock(K)`**. False ⇒ another writer is currently mid-write ⇒ `createIndexWriter`
   throws (surfaced) — a cheap "two daemons pointed at one DB" alarm. It does NOT hold the lock for
   the connection lifetime: holding a session-scoped lock is both reconnect-unsafe (a transparent
   reconnect silently drops it) AND would make the single-writer test un-runnable (you could never
   have the writer constructed *and* an external holder of `K`, codex round-3). The boot check is
   explicitly non-authoritative (it only catches a collision that happens to overlap that instant);
   the per-transaction lock below is the real guarantee.
2. **Per-transaction enforcement (the actual guarantee):** the FIRST statement of every write
   transaction acquires `pg_try_advisory_xact_lock(K)` AND **explicitly checks the boolean result**
   — `false` ⇒ throw (abort the tx, surface). The result MUST be read; do not fire-and-forget the
   query (codex round-2 Critical):
   ```ts
   const [{ locked }] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${K}) AS locked`);
   if (!locked) throw new Error('decision-index: another writer holds the store');
   ```
   A transaction-scoped lock holds no session state, so it is immune to reconnects — it re-asserts
   single-writer on every write regardless of which backend session postgres-js is currently using,
   and auto-releases at tx end. Because the in-process writer mutex (§3.5) already serializes the
   writer's own transactions, this lock never self-contends.
3. **Connection hardening:** the writer connection disables recycling
   (`postgres(url, { max: 1, idle_timeout: 0, max_lifetime: 0 })`) so reconnects are rare; the
   per-tx xact-lock makes correctness independent of them anyway.

This makes "exactly one writer" an enforced invariant — the per-tx `pg_try_advisory_xact_lock(K)` is
the **sole authoritative** mechanism (reconnect-safe, no held session state); the boot check is a
best-effort early warning. There is no lifetime-held session lock to release on `close()`.

### 3.5 Write-transaction serialization — DECISION

**Preserve better-sqlite3's serial semantics by serializing the writer's own transactions through
an in-process async queue (mutex), over the dedicated `max:1` connection.**

Justification: better-sqlite3 serialized ALL writes on one synchronous connection, so every
read-modify-write block (`reserve` select-then-insert; `recordFailure` read-attempts-then-update;
`apply` load-state-then-update-then-insert; `observeRequest` select-then-update) executed with NO
interleaving "for free." On async Postgres, two `runEffect`/`reconcile` calls can interleave at
`await` points. Rather than rewrite every block to `SELECT … FOR UPDATE`, the writer wraps
`withTx` in a process-local FIFO mutex so its transactions run one-at-a-time (matching sqlite),
AND uses the `max:1` connection so the DB itself serializes them. Combined with the rowCount-based
CAS (which is correct even without serialization — belt-and-suspenders) this preserves the exact
semantics the 270+ tests pin, with the smallest blast radius. Isolation level stays the postgres-js
default (READ COMMITTED); correctness rests on serialization + atomic CAS, not on SERIALIZABLE +
retry.

**The mutex MUST be re-entrant (codex Critical) — nested `withTx` is real and must NOT deadlock.**
`Outbox.commit()` (and `commitResumeTerminal`/`applyResumeAck`/`recordFailure`) open a `withTx`,
then call `apply(tx, …)`, and `apply()` itself opens `withTx(tx, …)` (`state-machine.ts:317`,
`outbox.ts:360`). On sqlite the inner call became a savepoint; a naive FIFO mutex that blocks on
re-entry from inside an already-held transaction would deadlock forever. Implement re-entrancy with
an `AsyncLocalStorage<{ tx }>` "current writer transaction" context:

```ts
const writerTxCtx = new AsyncLocalStorage<{ tx: Tx }>();
async function withTx(db, fn) {
  const current = writerTxCtx.getStore();
  if (current) return fn(current.tx);              // already inside the writer tx → REUSE it,
                                                   // no new mutex, no new transaction (flatten).
  return mutex.runExclusive(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${K})`); // §3.4 per-tx guard
      return writerTxCtx.run({ tx }, () => fn(tx));
    }),
  );
}
```

Flattening the inner call onto the outer tx (instead of a savepoint) MATCHES the documented intent —
`commit()`'s own comment says "we run `apply` inside the same outer txn" — so atomicity is preserved
and the "no advanced-state-with-stale-reserved row" invariant still holds in one commit. The mutex is
acquired exactly once, at the outermost entry. This is the single most important transaction-mechanics
fix in the port and is its own plan task with a dedicated nested-`withTx` no-deadlock test.

### 3.5a EVERY write goes through the one guarded primitive

**On sqlite, many writes bypass `withTx` and rely on the single connection serializing even bare
`db.insert().run()` calls** — verified bare-write paths: `IndexWriter.admit`
(`index-writer.ts:196` `this.db.insert(decisions)…run()`), `observeRequest`'s `update`s
(`:245,:260`), `setWorkerSession` (`:286`), `revealProtected`'s `appendAudit(this.db,…)` (`:476`),
`SqliteQuarantine.record`, `ProtectedStore.put` (`protected-store.ts:127`). On Postgres a bare
write outside `withTx` would hold **neither** the writer mutex (§3.5) **nor** the per-tx advisory
lock (§3.4) — defeating both single-writer enforcement and serial semantics (codex round-2
Critical). Therefore: **route 100% of mutations (insert/update/delete) through the single guarded
`withTx` primitive** (or a thin `write(fn)` alias over it). Concretely, wrap each currently-bare
write in `await withTx(this.db, async (tx) => { … })` so it acquires the mutex + advisory-lock
guard. Reads (`select`) stay outside `withTx` (they use the reader/own connection and need no lock).
A real-PG test (runnable BECAUSE the boot check is non-holding, §3.4): construct the writer while
`K` is free, THEN have a SECOND session take `pg_advisory_lock(K)` and HOLD it, THEN assert EVERY
public mutator (`admit`, `observeRequest`, `setWorkerSession`, `applyEvent`, `pin/mute/defer`,
`revealProtected` audit, `runEffect`, quarantine `record`, protected `put`) throws — proving the
per-tx xact lock covers every write path and no mutation bypasses the guard.

### 3.6 sync → async conversion strategy

The conversion is mechanical but pervasive. Every drizzle call returns a Promise on postgres-js, so:

- `db.ts`: `openDb` → opens writer connection + advisory lock (async); `openReadOnlyDb` → read-only
  pool. `withTx<T>` → `async withTx<T>(db, fn): Promise<T>` using `db.transaction(async (tx) => …)`
  **wrapped in the writer mutex** (§3.5). `Db` type becomes `PostgresJsDatabase<typeof schema>`.
- Convert every `.run()` → `await …` (drizzle insert/update execute on await), every
  `.all()` → `await …` (returns the array directly — drop `.all()`), every `.all()[0]`/`.get()` →
  `(await …)[0]`. Enumerated call-site owners: **`outbox.ts`** (the CAS core: `reserve`, `claim`,
  `releaseClaim`, `commit`, `commitResumeTerminal`, `applyResumeAck`, `markSuperseded`,
  `recordFailure`, `failDecisionTerminal`, `cancelReservedRows`, `isTerminal`, `loadItem`,
  `responseKey`, `responseRow`, `executeReserved`, `runResume`, `reconcile`,
  `pendingEffectDecisions` — all become `async`; `reconcile`'s `.filter/.some/.find` over `.all()`
  results move to `await`-then-array); **`state-machine.ts`** (`apply` → `async`, `loadState`,
  `validateAnswer` stays sync/pure, the two `decision_responses` guards + `appendAudit` awaited);
  **`index-writer.ts`** (`admit`, `observeRequest`, `setWorkerSession`, `applyEvent`,
  `applyWorkflow`, `pin/mute/defer/needMoreContext`, `revealProtected`, `runEffect`, `reconcile`,
  `pendingEffectDecisions` → `async`/`await`); **`read-model.ts`** (`get`, `list`, `listRanked`,
  `detail`, audit reads → `async`); **`audit-log.ts`** (`appendAudit` → `async`); **`quarantine.ts`**
  (`record` → `async`; `Quarantine.record` interface returns `Promise<void>`; `FakeQuarantine`
  updated); **`ingest.ts`** (`ingest` stays sync — it only builds the row + calls
  `quarantine.record`; make `quarantine.record` awaited where ingest is called, OR make `ingest`
  async — pick async to keep the quarantine write inside the same await chain).
- **`sanitizer-redaction/src/protected-store.ts`**: `Db` type → `PostgresJsDatabase<any>`; `put`,
  `findRefForField`, `metaOf`, `readVerified`, `get`, `verifyIntegrity`, `revealProtected`-callers
  become `async` (blob file I/O stays sync `fs`, but the `protected_refs` read/write awaits). The
  schema `sanitizer-redaction/src/schema.ts` → `pg-core` in the `decision_index` schema (it MUST
  resolve to the same physical `protected_refs` table the decision-index migration creates — one
  table, two drizzle definitions, as today).
- **`sanitizer-redaction/src/withholding-sanitizer.ts`** (codex round-2 Important — the store's
  CALLER): it invokes `store.findRefForField` (`:77`), `store.get` (`:81`), `store.put` (`:88`)
  **synchronously** inside its `sanitize`. Once the store is async these MUST be `await`ed, so the
  withholding sanitizer's `sanitize` becomes async — the `SynchronousSanitizer` contract it returns
  changes to the async sanitizer shape (an `AsynchronousSanitizer`/`Promise`-returning `sanitize`).
  The daemon already `await sanitizeDecisionRequest(request)` (`phases.ts:840,2176`), so the call
  boundary is already async; the pipeline type that selects sync-vs-async sanitizers
  (`sanitizer-redaction/src/index.ts`) must accept the async withholding sanitizer. Missing this
  file would leave `ref`/`reuseRef` as Promises and silently corrupt reuse/edit-convergence — add a
  withholding integration test (put → reuse-on-identical → fresh-mint-on-edit) over PGlite.
- **Public API ripple (consumers):** `DecisionLedger`'s now-async verbs (`raise`, `answer`,
  `supersede`, `expireOverdue`, `statusOf`, `pending`, `reader.*`) propagate `await` into
  `phases.ts:841,2177`, `reconcile.ts:52,68`, `daemon.ts:1552-1553`, `decision-api.ts`,
  `answer-publisher.ts`, `resume-consumer.ts`. Many wrappers (`supersedeIfMoot`, `markOverdue`,
  `advanceToResumed`) are ALREADY `async`, so the change is adding `await` inside them — the async
  boundary mostly already exists, which bounds the ripple.

### 3.7 outbox / audit / idempotent-transition semantics on Postgres

- **Answered-once** (`decision_responses` PK `decision_id`) and **idempotent transitions**
  (`applied_transitions` PK `(decision_id, transition_key)`): enforced by Postgres PKs exactly as
  by sqlite PKs. The code paths guard-then-insert under the serialized writer, so no unique-violation
  race arises; the PK remains the structural backstop.
- **Outbox two-phase**: `reserve` is idempotent on the deterministic PK `id`
  (select-then-insert under the writer mutex; optionally hardened to
  `insert … onConflictDoNothing` — recommended, since the deterministic id makes it a natural
  upsert and removes the read). `commit`/`commitResumeTerminal`/`recordFailure` run the transition
  apply + outbox update in ONE `db.transaction`, preserving "no advanced-state-with-stale-reserved
  window."
- **Append-only audit / quarantine**: `bigint generated always as identity` replaces sqlite
  autoincrement; insertion order + the `at` text timestamp preserve ordering. No code reads the
  numeric id, so the change is invisible to callers.
- **Deterministic effect id** is string concatenation — backend-independent; unchanged.

### 3.8 Fail-closed behavior change — DECISION

**Make escalation-surfacing always-available when the daemon's Postgres is configured; flip
`RUNFORGE_DECISION_INDEX_ENABLED` from a default-OFF hard gate to a default-ON explicit opt-OUT.**

- Today the flag defaults **false** SOLELY because of the `better-sqlite3` native module (a fresh
  env that can't load the native binary would crash on import, so surfacing was made opt-in +
  dynamically imported + fail-closed-to-`#broken`). Postgres removes that reason: the daemon
  already requires `RUNFORGE_DATABASE_URL`, so the store is present whenever the daemon runs.
- **New semantics:** the decision index initializes whenever `RUNFORGE_DATABASE_URL` is set
  (i.e. always, for a real daemon). `RUNFORGE_DECISION_INDEX_ENABLED=false` becomes an explicit
  opt-OUT escape hatch (a deployment that deliberately doesn't want the decision inbox); unset/any
  other value = enabled. `DecisionIndexManager.init()` no longer needs the dynamic import to dodge a
  native module (it MAY keep a static import now), and `#broken` now means only "Postgres genuinely
  unreachable" — the same fail-safe the daemon already has for its own state.
- **`isEnabled()` is NOT `isAvailable()` — broken-default-ON must fail VISIBLY, not return success
  (codex Critical).** Today the phases guard is `decisionManager?.isEnabled() === true`, which is
  just the configured flag (`manager.ts:51`); if init caught a broken writer (`#broken`), the guard
  still passes, `ledger()` throws, the `catch` logs, and the handler returns — leaving the run
  parked with NO surfaced `DecisionRequest` (exactly the gap-#2 invisible-stuck). Fixes:
  - Add `DecisionIndexManager.isAvailable()` = `enabled && !broken && ledger built`. The escalation
    paths in `phases.ts` (L2-gate ~828, integrate ~2163) gate structured surfacing on
    `isAvailable()`, not `isEnabled()`.
  - **The visible floors are NOT uniform across phases (codex round-2 Critical — verified):**
    - **L2-gate (`phases.ts` ~766):** the gate-issue **label + comment park happens unconditionally**
      (independent of the decision index), so a transient/broken structured surfacing still leaves a
      visible parked gate issue. Here, staying parked on a ledger failure is acceptable (visible
      floor exists).
    - **integrate (`phases.ts` ~2132):** there is **NO** unconditional GitHub label/comment floor.
      Today, when the index is **disabled**, integrate returns `'failure'` (held + visible failed
      run) — a deliberate fail-closed-visible. But when **enabled-but-broken** it `console.warn`s and
      returns `'success'` (parked, **invisible**). A default-ON flip would route the broken case down
      that invisible-park branch — a REGRESSION. **Fix:** at an escalate/hold integrate decision,
      when `isAvailable()` is false, return `'failure'` (held + visible failed run, matching today's
      disabled-path semantics) — NOT `'success'`. Only when the index is available AND the failure is
      a *transient* publish/raise error may integrate stay parked-and-retry (the structured block is
      the surface and it will retry next tick). Never return `'success'` for an escalate/hold that was
      not actually surfaced and has no visible floor.
  - When the index is `enabled` but `#broken` (Postgres genuinely unreachable), that is a LOUD
    operational alarm: keep the existing `console.error` "index unavailable — failing closed". L2-gate
    stays parked (visible gate issue); integrate returns `'failure'` (visible held run). Neither
    silently treats the escalation as resolved. Because Postgres is mandatory for the daemon, a
    persistently-broken index is a daemon-health condition, surfaced as such — not a per-run silent
    strand.
- **Fail-closed-to-VISIBLE-escalated:** with surfacing on by default, an escalate/hold verdict
  ALWAYS raises a durable `DecisionRequest` and surfaces it (block embed + notify) when Postgres is
  reachable. When Postgres is down: L2-gate leaves a visible parked gate issue; integrate produces a
  visible held/failed run. Never silently lost — fail-safe, not fail-to-invisible-stuck.
- **Why this is L1-aligned, not an L1 change:** L1/L2 (`ARCH-AC-DECISION-ESCALATION`) already
  require escalations be durable and "never silently lost." Default-OFF was an L3 implementation
  compromise forced by the native module; defaulting ON brings the implementation INTO compliance
  with L1. **Human-confirm parked (§9):** flipping a shipped default is borderline operator
  territory — recommend default-ON, but flag it for the operator rather than deciding unilaterally.
  The migration is mergeable with the flag still default-OFF if the operator prefers; the surfacing
  flip can be a one-line follow-up.

---

## 4. Migration / back-compat — greenfield, but PROVEN per-deployment (not assumed)

**No sqlite→Postgres data backfill tool.** Rationale (why greenfield is the right default):

- The flag defaults OFF and the native-module failure means a configured deployment that hit an
  escalation typically failed closed and parked (the gap-#2 symptom) rather than accumulating a
  durable answered-decision corpus.
- Decision rows are **transient in-flight escalations**, and per `ledger.ts` the GitHub
  label/comment is the v1 source of truth for resume — so rows that did exist are re-derivable.

**BUT the "no corpus exists" claim is NOT derivable from source (codex Important) — the repo DOES
support a persistent enabled sqlite store (`config.ts:78` resolves a real on-disk path;
`manager.ts:61` opens + migrates it). So greenfield is gated by an explicit per-deployment
preflight, not assumed:**

- **The runtime preflight must NOT open the sqlite file — that would reintroduce the very native
  module the migration removes (codex round-2 Critical).** So the boot check is a pure
  **file-existence** test (`fs.existsSync`) on the legacy sqlite path
  (`RUNFORGE_DECISION_INDEX_PATH`, default `<stateDir>/decision-index.sqlite`), with NO
  `better-sqlite3` open. If the file exists AND `RUNFORGE_DECISION_INDEX_CUTOVER_ACK` is NOT set,
  the daemon **aborts boot with an actionable error** ("a legacy sqlite decision store exists at
  <path>; it may hold unanswered escalations. Run the one-shot export tool to salvage them, or set
  `RUNFORGE_DECISION_INDEX_CUTOVER_ACK=1` to proceed greenfield, then delete the file"). This is
  fail-closed (won't silently drop a store) and native-free at runtime.
- **Row inspection / export is an OPTIONAL separate pre-migration CLI tool** (e.g.
  `packages/decision-index/scripts/export-legacy-sqlite.ts`) that DOES carry the old
  `better-sqlite3` dependency and is run manually by an operator who wants to salvage data. It is
  NOT on the daemon boot path, so the runtime stays native-free. (In practice — flag default-OFF +
  the native-load failure — this tool is rarely needed; it exists so greenfield is a choice, not a
  silent loss.)
- With the ack env set (or no file present), cutover proceeds greenfield: the `decision_index`
  Postgres tables start empty; the sqlite file is left on disk untouched (operator deletes it). No
  dual-read, no backfill.
- This is fail-closed: we never silently lose a durable escalation, but we also never build a
  migration tool for a corpus that in practice is empty.

Document the cutover + the ack env in the L3 gotchas.

---

## 5. Test strategy

- **In-process Postgres via PGlite — added as an explicit dep (codex Important).** Replace
  `makeTempDb()` (on-disk sqlite) with an in-process `@electric-sql/pglite` instance wired through
  `drizzle-orm/pglite`. PGlite appears in the lockfile ONLY as an optional drizzle peer (`>=0.2.0`)
  — neither affected package declares it — so it must be **added explicitly** as a `devDependency`
  of `@runforge/decision-index` (and `@runforge/sanitizer-redaction` where its tests need it).
  PGlite is a real Postgres (MVCC, transactions, advisory locks, `FOR UPDATE`, `RETURNING`) compiled
  to WASM, so the ~60 logic tests keep their "spin up a fresh migrated DB in `beforeEach`, no Docker"
  ergonomics. `makeTempDb()` → `makePgliteDb()` returning `{ db, cleanup }`; `cleanup` closes the
  PGlite instance. The migration runner applies the `decision_index` migrations to it.
- **CAS / concurrency tests** (`concurrent-claim.test.ts`, `owner-generation-claim.test.ts`,
  `crash-recovery.test.ts`, the outbox-* suite): keep them, but the assertion shifts to the
  rowCount-based claim. PGlite is single-backend (queues concurrent queries), which matches the
  single-writer model; the rowCount CAS is provably correct under serialized execution, so the
  "two claimers, one wins" assertions hold deterministically. Add ONE focused test that issues two
  overlapping `claim(id)` calls and asserts exactly one returns true and the other observes the row
  already `executing`.
- **REQUIRED real-Postgres integration test (codex Important — not optional).** PGlite is a single
  in-process backend and **cannot prove cross-process / multi-session locking**, so the
  cross-process single-writer guarantee must be tested against a real Postgres. Add a suite that runs
  against `RUNFORGE_TEST_DATABASE_URL` and make it a **required CI job** backed by a
  `postgres:18-alpine` service (already in `docker-compose.yml`; CI gets a `services: postgres`
  block). It exercises: (1) construct the writer while `K` is free, THEN a second session holds
  `pg_advisory_lock(K)` and EVERY public mutator throws (the per-tx xact-lock proof, §3.5a — runnable
  precisely because the boot check is non-holding); (2) the boot fast-fail throws when a second
  session is already holding `K` at construction time; (3) a read-only session rejects writes.
  Locally the suite `describe.skip`s when `RUNFORGE_TEST_DATABASE_URL` is unset, but CI must set
  it — the cross-process invariant is safety-critical and PGlite leaves it unproven.
- **Per-package commands** (confirmed): decision-index uses `pnpm --filter @runforge/decision-index test`
  (`vitest run`) and `pnpm --filter @runforge/decision-index typecheck` (`tsc --noEmit`);
  sanitizer-redaction and daemon analogously. Run the affected specs' `test_paths` after each task.
- **Daemon consumer tests** (13 files under `decision-escalation/`, plus `decision-api*.test.ts`,
  sanitization integration tests): update their fakes/fixtures to the async ledger + PGlite-backed
  manager. Several already `await` the ledger wrappers.

---

## 6. Risks

1. **CAS unsoundness if ported naively** (HIGH) — the read-before/read-after claim must become
   rowCount-based (§3.4). Mitigation: §3.4 is the first correctness task; the focused concurrency
   test pins it.
2. **Interleaving of async transactions** (HIGH) — without the writer mutex (§3.5), read-modify-write
   blocks could interleave and break answered-once / attempt-counting / terminal-cancel invariants.
   Mitigation: writer mutex + `max:1` connection reproduce serial semantics; the existing
   crash-recovery + outbox suites are the regression net.
2b. **Mutex deadlock on nested `withTx`** (HIGH) — `commit`/`apply` nest transactions; a naive mutex
   would deadlock. Mitigation: re-entrant `AsyncLocalStorage` tx context (§3.5) + a dedicated
   nested-`withTx` no-deadlock test as an early task.
2c. **Broken-default-ON silent strand** (HIGH) — `isEnabled()` ≠ available; a broken index could
   park-and-return without surfacing. Mitigation: `isAvailable()` guard + the always-visible GitHub
   gate-issue park floor (§3.8).
2d. **Advisory-lock loss on reconnect** (HIGH) — a session-scoped lock dies on a transparent
   reconnect. Mitigation: transaction-scoped `pg_try_advisory_xact_lock` per write tx + disabled
   connection recycling (§3.4).
2e. **Writes that bypass the guard** (HIGH) — bare `db.insert().run()` paths (`admit`,
   `observeRequest`, `setWorkerSession`, audit, quarantine, protected `put`) would hold neither mutex
   nor lock. Mitigation: route 100% of mutations through `withTx` (§3.5a) + a real-PG test that an
   externally-held lock fails every public mutator.
2f. **integrate-park invisible regression** (HIGH) — default-ON could route a broken index at an
   escalate/hold integrate decision into the `return 'success'` invisible-park branch. Mitigation:
   integrate returns `'failure'` (visible held run) when `isAvailable()` is false (§3.8).
3. **Cross-package async ripple** — `ProtectedStore` (sanitizer-redaction) becoming async ripples
   into ingest + every reveal path. Mitigation: convert it in the same slice as the schema move;
   it shares the writer connection so it stays inside the writer mutex.
4. **Connection lifecycle / advisory-lock loss** — a lifetime-held SESSION lock would die on a
   transparent reconnect (the round-3 failure mode). Mitigation: do NOT hold a session lock; the
   per-transaction `pg_try_advisory_xact_lock(K)` (§3.4 layer 2) re-asserts on every write and is
   reconnect-safe; the boot check is non-holding; `max:1` + disabled recycling keep reconnects rare.
5. **Test backend fidelity** — PGlite is single-backend; true OS-level parallel races aren't
   reproduced. Mitigation: rowCount CAS is correct under serialization; the gated real-PG suite
   covers advisory-lock + read-only-session behavior PGlite can't (multi-session).
6. **Behavior-default flip** — defaulting surfacing ON changes shipped behavior. Mitigation:
   parked as a human-confirm (§9); the store migration is independently mergeable with the flag
   left default-OFF.
7. **`audit_log`/`quarantine_events` identity columns** — `generated always as identity` vs sqlite
   autoincrement. Mitigation: no caller reads the numeric id; insertion order + `at` preserve
   ordering (covered by `read-model-dashboard` / audit tests).

---

## 7. L3 spec + traceability update

**Sequencing (codex Important):** the canonical L3 still says `better-sqlite3` (version 1) and
traceability omits sanitizer-redaction — by design. This design doc is the forward-looking artifact;
the L3 **prose** edits + traceability additions land **atomically with the implementation** as the
FINAL plan task (so the canonical L3 never describes a not-yet-existent Postgres impl, and
`code_paths` never point at unbuilt files). The planner does NOT pre-edit the canonical L3 here. The
concrete edits to make at that task:

- **Update `.specify/stack/decision-escalation-store-ts.md`** (`STACK-AC-DECISION-ESCALATION-STORE`,
  bump `version: 1` → `2`). Allowed: L3 documents the stack/impl. Changes:
  - "Drizzle ORM over **better-sqlite3** (WAL, single-writer)" → "Drizzle ORM over **Postgres**
    (postgres-js, dedicated `decision_index` schema, single-writer)"; replace WAL with MVCC.
  - Record the CAS mapping as **atomic `UPDATE … RETURNING` rowCount** (not read-after) + the
    cross-process single-writer enforcement (boot `pg_try_advisory_lock` fast-fail **plus** a
    per-write-transaction `pg_try_advisory_xact_lock` as the reconnect-safe correctness mechanism) +
    the re-entrant **writer-mutex / `max:1`** serialization that preserves sqlite's serial semantics.
  - Add gotchas: "never decide the CAS winner by re-reading state — use the affected-row count";
    "single-writer is enforced by a **per-transaction** advisory xact-lock (session lock is only a
    boot fast-fail) — one writer process per database; check the lock's boolean result"; "EVERY
    mutation must go through the guarded `withTx` primitive — no bare `db.insert().run()`"; "the
    writer mutex must be **re-entrant** (nested `withTx` from `commit`→`apply`)"; "timestamps stay
    ISO-8601 text"; "greenfield cutover is a file-existence check + ack env — runtime never opens the
    sqlite file (no native dep); export is a separate optional tool"; "back up Postgres AND
    `protectedDir` together."
  - Keep the lifecycle / deterministic-effect-id / audit-only-substeps / answer-from-notified
    gotchas verbatim (unchanged by the store move).
- **`code_paths`** (add the sanitizer-redaction protected store; keep existing): `packages/decision-protocol/`,
  `packages/decision-index/`, `packages/sanitizer-redaction/src/protected-store.ts`,
  `packages/sanitizer-redaction/src/schema.ts`.
- **`test_paths`**: keep `packages/decision-protocol/**/*.test.ts`, `packages/decision-index/**/*.test.ts`;
  add `packages/sanitizer-redaction/**/*.test.ts`.
- **`.specify/traceability.yml`**: mirror the same `code_paths`/`test_paths` additions under the
  `STACK-AC-DECISION-ESCALATION-STORE` entry (lines ~183-190). No new spec node; no parent change.
  `STACK-AC-DECISION-ESCALATION-EMITTER` (the daemon wiring) is unchanged structurally but its
  files gain `await`s.
- **No L2/L1/L0 edit.** `ARCH-AC-DECISION-ESCALATION` is store-agnostic (verified §2/§refs).

---

## 8. Out of scope

`timestamptz` migration; moving `.enc` blob bodies into Postgres; merge-decision/risk-gate changes;
PHI/redaction features; removing the `RUNFORGE_DECISION_INDEX_PATH`/sqlite env var names beyond
deprecation; dashboard/HTTP projection changes beyond the await ripple.

---

## 9. Human-only open question (parked)

**Default-flip of `RUNFORGE_DECISION_INDEX_ENABLED` (OFF → ON / opt-out).** Recommended ON
(L1-aligned: escalations should always surface). Borderline operator territory because it changes
shipped default behavior. The store migration (§2-§7) is mergeable independently with the flag left
default-OFF; the surfacing flip can land as a one-line follow-up once the operator confirms. Decide:
flip the default in THIS migration, or as a gated follow-up.
