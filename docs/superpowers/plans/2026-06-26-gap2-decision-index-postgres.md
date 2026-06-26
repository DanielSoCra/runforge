# Implementation Plan — Decision-Index Postgres Migration (Gap #2)

- **Spec:** `docs/superpowers/specs/2026-06-26-gap2-decision-index-postgres-design.md` (read it first)
- **Branch/worktree:** `codex/779-gap2-postgres-migration-build` @
  `~/code/auto-claude/.claude/worktrees/779-gap2`
- **Method:** TDD. For each task: write/adjust the failing test, implement, run the package's
  `test` + `typecheck`, then proceed. Estimate: ~4-5 engineering days (the sync→async outbox
  conversion + the consumer ripple dominate).
- **Per-package commands (confirmed):**
  - `pnpm --filter @auto-claude/decision-index test` and `pnpm --filter @auto-claude/decision-index typecheck`
  - `pnpm --filter @auto-claude/sanitizer-redaction test` and `pnpm --filter @auto-claude/sanitizer-redaction typecheck`
  - `pnpm --filter @auto-claude/daemon test` and `pnpm --filter @auto-claude/daemon typecheck`
  - drizzle gen (after schema): `pnpm --filter @auto-claude/decision-index exec drizzle-kit generate`
- **Line numbers:** all references below say "grep for X" — resolve dynamically, never hardcode.

> **Sequencing rule:** the canonical L3 (`STACK-AC-DECISION-ESCALATION-STORE`) + `traceability.yml`
> edits are the FINAL task (Task 13), landed atomically with code, so the L3 never describes a
> not-yet-existent impl. Do NOT edit them earlier.

---

## Phase A — foundation (deps, schema, migrations, connection layer)

### Task 1 — deps + drizzle dialect switch

- `packages/decision-index/package.json`:
  - **dependencies:** add `"postgres": "^3.4.9"`; **remove** `"better-sqlite3"` and
    `"@types/better-sqlite3"` from runtime deps (keep `drizzle-orm`, `ulid`, `ajv`, `zod`).
  - **devDependencies:** add `"@electric-sql/pglite": "^0.2.0"` (the in-process test backend — it is
    only a drizzle peer in the lockfile today, must be declared) and `"better-sqlite3": "^12.0.0"`
    ONLY if Task 12's legacy-export tool lives in this package (it carries the old dep, isolated).
- `packages/sanitizer-redaction/package.json`: mirror — drop `better-sqlite3` runtime dep, add
  `postgres`; add `@electric-sql/pglite` devDep.
- `packages/decision-index/drizzle.config.ts`: `dialect: "sqlite"` → `dialect: "postgresql"`;
  `out: "./src/migrations"` → `out: "./drizzle"` (mirror `packages/db`); add
  `dbCredentials: { url: process.env.AUTO_CLAUDE_DATABASE_URL! }`.
- `pnpm install` from repo root.
- **Verify:** `pnpm --filter @auto-claude/decision-index typecheck` (will fail on schema/db until
  later tasks — expected; just confirm deps resolve / install succeeds).

### Task 2 — port schema to `pg-core` under a dedicated `decision_index` schema

- Rewrite `packages/decision-index/src/schema.ts` using `drizzle-orm/pg-core` and
  `pgSchema('decision_index')` (pattern reference: `packages/db/src/schema.ts`). Mapping per spec
  §3.2: `text().primaryKey()` unchanged; `integer({mode:"boolean"})` → `boolean()`
  (`stale`,`pinned`,`muted`,`superseded`); `integer().primaryKey({autoIncrement:true})` →
  `bigint('id',{mode:'number'}).primaryKey().generatedAlwaysAsIdentity()` (`audit_log`,
  `quarantine_events`); **all ISO timestamp fields stay `text()`**; composite `primaryKey({columns})`
  and FK `.references()` unchanged. Export the same table names (`decisions`, `decisionResponses`,
  `appliedTransitions`, `auditLog`, `outbox`, `workerSessions`, `protectedRefs`, `quarantineEvents`).
  Delete the `SCHEMA_SQL_PRAGMAS` export (sqlite-only).
- Rewrite `packages/sanitizer-redaction/src/schema.ts` → `pg-core`, `protectedRefs` in the SAME
  `decision_index` pgSchema (one physical table, two drizzle defs, as today).
- **Test:** `packages/decision-index/test/schema-shape.test.ts` (new) — assert every table is
  exported and the boolean/identity columns have the right drizzle column type. Run
  `pnpm --filter @auto-claude/decision-index typecheck`.

### Task 3 — generate the Postgres migration SQL + production migrator

> NOTE (codex Critical): the production migrator (postgres-js) and the test harness migrator
> (PGlite) are DIFFERENT drizzle entrypoints and are NOT interchangeable. This task does the SQL
> generation + the production (postgres-js) migrator only; the PGlite harness is Task 4 and applies
> the SAME generated SQL via the PGlite path. The migrate TEST moves to Task 4 (after the harness
> exists), so nothing here depends on a not-yet-built helper.

- Generate: `pnpm --filter @auto-claude/decision-index exec drizzle-kit generate` → produces
  `packages/decision-index/drizzle/0000_init.sql` + `meta/`. **Hand-edit** the generated SQL to
  prepend `CREATE SCHEMA IF NOT EXISTS decision_index;` if drizzle-kit did not emit it for the
  `pgSchema`. Delete the old `packages/decision-index/src/migrations/` dir (the 6 sqlite migrations).
- Rewrite `packages/decision-index/src/migrate.ts` to the postgres-js migrator (pattern:
  `packages/db/src/migrate.ts`): `import { migrate as pgMigrate } from
  'drizzle-orm/postgres-js/migrator'`; export `async function migrate(db: PostgresJsDatabase,
  migrationsFolder = <resolve ../drizzle>)` calling `pgMigrate(db, { migrationsFolder,
  migrationsSchema: 'decision_index' })`.
- **Verify:** `pnpm --filter @auto-claude/decision-index typecheck` compiles `migrate.ts` (no DB run
  needed here).

### Task 4 — PGlite test harness (applies the SAME generated SQL) + migrate test

- Rewrite `packages/decision-index/test/helpers/temp-db.ts`: `makeTempDb()` → `async
  makePgliteDb()` returning `{ db, cleanup }`. `import { PGlite } from '@electric-sql/pglite'` +
  `import { drizzle } from 'drizzle-orm/pglite'`; create a fresh in-memory PGlite. Apply the
  migration via the **PGlite migrator** (`import { migrate } from 'drizzle-orm/pglite/migrator'`,
  `migrate(db, { migrationsFolder: <../../drizzle>, migrationsSchema: 'decision_index' })`); if that
  entrypoint is unavailable in the installed drizzle version, fall back to reading
  `drizzle/0000_init.sql` and `await pglite.exec(sql)` (raw apply — dialect-correct since the SQL is
  Postgres). Return the drizzle db; `cleanup()` calls `pglite.close()`. Keep `TEST_PROTECTED_KEY`.
- **Test:** `packages/decision-index/test/migrate.test.ts` — `makePgliteDb()` then assert the
  `decision_index` tables exist (`SELECT … information_schema.tables WHERE
  table_schema='decision_index'`) + a trivial insert/select round-trips. Run
  `pnpm --filter @auto-claude/decision-index test test/migrate.test.ts`.

### Task 5 — connection layer + re-entrant guarded `withTx` (the heart)

This is the highest-risk task; give it its own tests.

- Rewrite `packages/decision-index/src/db.ts`:
  - `Db` type → `PostgresJsDatabase<typeof schema>`.
  - `openDb(opts)` → opens the **writer** connection: `postgres(url, { max:1, idle_timeout:0,
    max_lifetime:0 })`, drizzle over it, run boot fast-fail (spec §3.4 layer 1: `pg_try_advisory_lock(K)`
    then immediate `pg_advisory_unlock(K)`; throw if false), return `{ db, sql }` (need the raw `sql`
    to `end()` on close). `K = hashtext('auto-claude:decision-index:writer')` — compute once.
  - `openReadOnlyDb(opts)` → read-only pool: `postgres(url, { connection: {
    default_transaction_read_only: 'on' } })`, drizzle over it.
  - Re-entrant guarded `withTx` (spec §3.5 + §3.4 layer 2): an
    `AsyncLocalStorage<{ tx }>` "current writer tx" context + a process-local FIFO mutex. If already
    inside the writer tx → reuse `current.tx` (no mutex, no new tx). Else `mutex.runExclusive(() =>
    db.transaction(async (tx) => { const [{ locked }] = await tx.execute(sql\`SELECT
    pg_try_advisory_xact_lock(${K}) AS locked\`); if (!locked) throw …; return ctx.run({tx}, () =>
    fn(tx)); }))`. Signature becomes `async withTx<T>(db, fn): Promise<T>`.
- **Tests** (`packages/decision-index/test/withtx-guard.test.ts`, new, over PGlite):
  1. nested `withTx(db, t1 => withTx(t1, t2 => …))` does NOT deadlock and both run in one tx
     (write in inner is visible after outer commit; both roll back together on throw).
  2. `withTx` rolls back on a thrown error (no partial write).
  3. (advisory-lock cross-process behavior is the real-PG **Task 12** test — PGlite is single-session.)

---

## Phase B — package internals: CAS + sync→async conversion

### Task 6 — rewrite the CAS claim to rowCount (correctness-critical)

- In `packages/decision-index/src/outbox.ts` (grep `private claim(`): replace the
  read-before/update/read-after body with the atomic form (spec §3.4):
  `const won = (await tx.update(outbox).set({state:'executing', claimed_at:now,
  claimed_by:this.generation}).where(and(eq(outbox.id,id), eq(outbox.state,'reserved'))).returning({
  id: outbox.id })).length === 1; return won;`. Wrap in `await withTx`.
- **Test:** `packages/decision-index/test/cas-rowcount-claim.test.ts` (new) — two overlapping
  `claim(id)` calls (await one then the other, single PGlite backend): exactly one returns `true`,
  the second returns `false` and observes the row already `executing`. Keep
  `concurrent-claim.test.ts` / `owner-generation-claim.test.ts` green (adapt to async).

### Task 7 — convert the leaf write/read modules to async

Order: leaves first (no inter-module await surprises). For EACH, convert sync drizzle calls
(`.run()` → `await`; `.all()` → `await` returning the array, drop `.all()`; `.all()[0]`/`.get()` →
`(await …)[0]`) and route EVERY mutation through `await withTx` (spec §3.5a — no bare
`db.insert().run()`):

- `audit-log.ts`: `appendAudit(db, entry)` → `async appendAudit(tx, entry)` (callers already pass a
  tx; keep it tx-scoped — it's always called inside an apply/commit txn).
- `quarantine.ts`: `SqliteQuarantine.record` → `async record`; `Quarantine.record` interface returns
  `Promise<void>`; rename class to `PgQuarantine`; update `FakeQuarantine` to async.
- `ingest.ts`: make `ingest()` async (it `await`s `quarantine.record` on the fail-closed paths).
- `read-model.ts` (grep `\.all()`): `get`, `list`, `listRanked`, `detail`, audit reads → `async`.
- **Tests:** adapt `quarantine-content-free.test.ts`, `read-model-dashboard.test.ts`,
  `response-payload.test.ts` to `await`. Run `... test`.

### Task 8 — convert `state-machine.ts` (`apply`)

- Grep `export function apply` and the `withTx` inside it. `apply(db, …)` → `async apply(db, …):
  Promise<ApplyResult>`; keep `validateAnswer`/`canonicalize`/`hashPayload` **sync/pure**. Inside,
  every `tx.select()…all()`/`tx.insert()…run()`/`tx.update()…run()` + `appendAudit(tx,…)` becomes
  `await`. The `withTx` here is re-entrant: when `apply` is called with a `tx` from outbox `commit`,
  it reuses that tx (Task 5) — verify no double-mutex.
- **Tests:** `state-machine.golden.test.ts`, `answered-once.test.ts`, `answer-validation.test.ts`,
  `protocol-version-guard.test.ts` → `await apply(...)`. Run `... test`.

### Task 9 — convert `outbox.ts` (the big one) + `index-writer.ts`

- `outbox.ts`: make every method that touches the db async (grep `\.all()`/`\.run()`/`withTx`):
  `reserve` (optionally `insert … onConflictDoNothing` per spec §3.7 to drop the pre-read),
  `releaseClaim`, `commit`, `commitResumeTerminal`, `applyResumeAck`, `markSuperseded` (already
  async — await the inner withTx), `recordFailure`, `failDecisionTerminal`, `cancelReservedRows`,
  `isTerminal`, `loadItem`, `responseKey`, `responseRow`, `effectIdFor`, `executeReserved`,
  `runResume`, `reconcile` (its `.all().filter/.some/.find` become `(await …).filter/...`),
  `pendingEffectDecisions`, `probe` (already async). The inline supersede update in `runResume`
  (grep `superseded: true, state: "reserved"`) → `await withTx`.
- `index-writer.ts`: `admit`, `observeRequest`, `setWorkerSession`, `applyEvent`, `applyWorkflow`,
  `pin/mute/defer/needMoreContext`, `revealProtected`, `runEffect`, `reconcile`,
  `pendingEffectDecisions` → async; wrap the bare `this.db.insert(decisions)…run()` in `admit` and
  the `observeRequest`/`setWorkerSession`/`revealProtected`-audit writes in `await withTx` (spec
  §3.5a). `createIndexWriter` → `async` (it `await`s `openDb` + `migrate`); `close()` → `async`
  (await `sql.end()` + boot lock already released). Keep the handle-leak `catch` (await
  `sql.end()` on failure).
- **Tests:** the whole `outbox-*` suite (~18 files), `index-writer.test.ts`,
  `index-writer-handle-leak.test.ts`, `crash-recovery.test.ts`, `effect-reconcile.test.ts`,
  `workflow-ops.test.ts`, `concurrent-claim.test.ts`, `gated-writer.test.ts` (the readonly-rejects
  test now asserts the Postgres read-only session throws) → `await`. Run `... test` until green.

### Task 10 — convert `ProtectedStore` + `withholding-sanitizer`

- `packages/sanitizer-redaction/src/protected-store.ts`: `Db` → `PostgresJsDatabase<any>`; `put`,
  `findRefForField`, `metaOf`, `readVerified`, `get`, `verifyIntegrity` → async (blob `fs` stays
  sync; the `protected_refs` read/write awaits). Wrap the `put` insert in `await withTx`-equivalent
  — but ProtectedStore shares the writer connection; expose a guarded write via the same
  AsyncLocalStorage context (when `put` runs inside an ingest withTx it reuses the tx; standalone it
  opens one). Simplest: have `createIndexWriter` inject a `withTx` bound to the writer db, and the
  ProtectedStore uses it for the pointer insert.
- `packages/sanitizer-redaction/src/withholding-sanitizer.ts` (spec §3.6 — codex round-2): grep
  `options.store.findRefForField`/`.get`/`.put` — `await` all three; `sanitize` becomes
  `async sanitize(...): Promise<SanitizationResult>`. Change `SynchronousSanitizer` →
  an async sanitizer interface (or a new `AsynchronousSanitizer` with `sanitize(): Promise<…>`);
  update `createWithholdingSanitizer`/`createWithholdingFactory` return types and the
  `packages/sanitizer-redaction/src/index.ts` exports. Confirm the daemon's sanitizer pipeline
  (`phases.ts:200 sanitizeDecisionRequest`, already `async`) awaits sanitizer results.
- **Tests:** `packages/sanitizer-redaction/**/*.test.ts` → `await`; ADD a withholding integration
  test over PGlite: `put` → reuse-on-identical-value → fresh-mint-on-edit. Run
  `pnpm --filter @auto-claude/sanitizer-redaction test`.

---

## Phase C — consumers, config/fail-closed, integration test, specs

### Task 11 — daemon consumers + manager `isAvailable` + ledger async

- `packages/daemon/src/control-plane/decision-escalation/ledger.ts`: the verbs that call now-async
  writer methods become async — `raise` (→ `await observeRequest`), `answer`/`supersede`/
  `expireOverdue` (→ `await applyEvent`; `expireOverdue` awaits in its loop), `statusOf`/`pending`/
  `reconcile`/`reader.*` → async. Update `NotifyResult`/`AnswerResult` call sites.
- `manager.ts`: add `isAvailable(): boolean` = `#enabled && !#broken && this.#ledger !== null`.
  `init()` may switch the dynamic import to a STATIC import now (native dep gone) — but keep the
  try/catch `#broken` for Postgres-unreachable. `close()` → `await this.#writer?.close()`.
- `config.ts`: implement the STORE migration parts of spec §3.8 + §4 — **keep
  `AUTO_CLAUDE_DECISION_INDEX_ENABLED` default-OFF for now** (the default-ON flip is operator-gated:
  Task 11b / spec §9). Replace `dbPath` (sqlite) with the Postgres `AUTO_CLAUDE_DATABASE_URL`
  plumbing; keep `protectedDir`/`protectedKey`. Add the **file-existence-only** cutover preflight
  (`fs.existsSync(legacySqlitePath)` + `AUTO_CLAUDE_DECISION_INDEX_CUTOVER_ACK` ⇒ abort boot with the
  actionable error if the file is present and no ack; **never open the sqlite file**). This task is
  mergeable independently with the default OFF (per spec §9 "store migration mergeable with
  default-OFF").
- `phases.ts`: grep `decisionManager?.isEnabled() === true` (L2-gate ~line of `[l2-gate] decision
  block`, integrate ~`[integrate] decision-index`) → gate structured surfacing on `isAvailable()`.
  **Integrate fix (spec §3.8):** at an escalate/hold integrate decision, when `isAvailable()` is
  false → `return 'failure'` (visible held run), NOT `'success'`. Add `await` to `ledger.raise`
  (grep `ledger.raise(sanitized)`). L2-gate keeps its unconditional label/comment park (already
  there).
- `daemon.ts` (grep `decisionManager.ledger().reader`), `decision-api.ts`, `reconcile.ts`
  (grep `ledger.supersede`/`ledger.expireOverdue`), `answer-publisher.ts`, `resume-consumer.ts`:
  add `await` to the now-async ledger/reader calls (most wrappers are already `async`).
- **Tests:** the 13 `decision-escalation/*.test.ts` + `decision-api*.test.ts` + sanitization
  integration tests — update fakes to async ledger + PGlite-backed manager (inject `importer`/db).
  Add a `manager` test: `isAvailable()` false when `#broken`; an integrate-phase test: unavailable
  index at escalate/hold returns `'failure'` (visible), not `'success'`. Run
  `pnpm --filter @auto-claude/daemon test`.

### Task 11b — OPERATOR-GATED: flip the default to ON (opt-out) — closes gap #2 surfacing

> **DO NOT execute until the operator confirms the default-flip (spec §9).** Everything above
> (Tasks 1-11) is the store migration and is mergeable with the flag default-OFF. This task is the
> behavior change that actually makes escalations always-surface.

- `config.ts`: flip `AUTO_CLAUDE_DECISION_INDEX_ENABLED` to default-ON opt-OUT — the index
  initializes whenever `AUTO_CLAUDE_DATABASE_URL` is set; `=false` is the explicit opt-out escape
  hatch (spec §3.8). (The static-import switch already landed in Task 11 — native dep is gone after
  Tasks 1-10, independent of this flag.)
- **Test:** a config test asserting unset ⇒ enabled, `=false` ⇒ disabled; an integration test that
  an escalate/hold verdict on a fresh (DB-configured) deployment surfaces a DecisionRequest by
  default. Run `pnpm --filter @auto-claude/daemon test`.

### Task 12 — REQUIRED real-Postgres integration test + CI service + (optional) legacy export tool

- `packages/decision-index/test/integration/cross-process-writer.pg.test.ts` (new, spec §5):
  `describe.skip` unless `AUTO_CLAUDE_TEST_DATABASE_URL`. Cases: (1) construct writer while `K`
  free, then a SECOND `postgres` session `pg_advisory_lock(K)` and assert EVERY public mutator
  throws; (2) boot fast-fail throws when a second session holds `K` at construction; (3) read-only
  session rejects a write.
- **Schema isolation (codex Important):** `decision_index` is hardcoded in `pgSchema(...)`, so a
  "unique schema per run" is NOT possible without making the name configurable. Instead run this
  suite **serially** (`vitest` `--no-file-parallelism` or a dedicated config) and
  `DROP SCHEMA IF EXISTS decision_index CASCADE` in `beforeAll`, then migrate fresh. (Alternatively
  point `AUTO_CLAUDE_TEST_DATABASE_URL` at a throwaway *database*.)
- **CI (codex Important — concrete):** the repo has ONE workflow `.github/workflows/ci.yml` (single
  `ci` job, `runs-on: self-hosted`, steps `pnpm typecheck` / `pnpm test` / `pnpm build`). Add a
  `services: postgres:` block (`image: postgres:18-alpine`, `POSTGRES_DB/USER/PASSWORD` env, a
  `pg_isready` health check) to that job. **The job runs directly on `self-hosted` (NOT inside a job
  container), so the service container must publish the port** — add `ports: ["5432:5432"]` (or read
  the runner-assigned `job.services.postgres.ports['5432']` into the URL) so `localhost:5432` is
  reachable. Set `AUTO_CLAUDE_TEST_DATABASE_URL` + `AUTO_CLAUDE_DATABASE_URL`
  (`postgres://<user>:<pass>@localhost:5432/<db>`) env on the `Test` step so the integration suite is
  REQUIRED (not skipped). NOTE: the runner is self-hosted (known shared-resource contention) — keep
  the real-PG suite serial, and ensure a unique DB or `DROP SCHEMA` so concurrent CI runs don't
  collide.
- (Optional) `packages/decision-index/scripts/export-legacy-sqlite.ts` — the ONLY place
  `better-sqlite3` survives; a manual operator tool that reads the legacy sqlite and dumps live rows
  to JSON. Not on any runtime path.
- **Verify (local):** compose requires the `POSTGRES_*` vars (they are `:?`-mandatory in
  `docker-compose.yml`), so:
  `POSTGRES_DB=ac POSTGRES_USER=ac POSTGRES_PASSWORD=ac docker compose up -d postgres` then
  `AUTO_CLAUDE_TEST_DATABASE_URL=postgres://ac:ac@localhost:5432/ac
  AUTO_CLAUDE_DATABASE_URL=postgres://ac:ac@localhost:5432/ac pnpm --filter @auto-claude/decision-index test`
  → the integration suite passes.

### Task 13 — L3 spec + traceability (FINAL, atomic with code)

- Update `.specify/stack/decision-escalation-store-ts.md` per spec §7: bump `version: 1` → `2`;
  swap better-sqlite3/WAL → Postgres/MVCC/`decision_index` schema; record CAS rowCount + per-tx
  `pg_try_advisory_xact_lock` (correctness) + boot fast-fail + re-entrant writer-mutex/`max:1`;
  add the new gotchas (rowCount CAS, per-tx lock + boolean check, every-write-through-withTx,
  re-entrant mutex, timestamps stay text, file-existence cutover, back up Postgres + `protectedDir`).
  Add `code_paths`: `packages/sanitizer-redaction/src/protected-store.ts`,
  `packages/sanitizer-redaction/src/schema.ts`; `test_paths`:
  `packages/sanitizer-redaction/**/*.test.ts`.
- Update `.specify/traceability.yml` `STACK-AC-DECISION-ESCALATION-STORE` entry (grep the node) with
  the same `code_paths`/`test_paths` additions.
- Update `.specify/traceability.yml` env/path notes if `AUTO_CLAUDE_DECISION_INDEX_PATH` semantics
  changed.
- **Verify (codex Important — exact validator):** the traceability validator is the daemon test
  `pnpm --filter @auto-claude/daemon exec vitest run src/infra/traceability-paths.test.ts`
  (`packages/daemon/src/infra/traceability-paths.test.ts` — checks path existence + parent/child
  reciprocity). There is NO root `spec` script. Run that; confirm all `code_paths` point at files
  that now exist.

---

## Final verification (before commit on the implementation branch)

1. `pnpm --filter @auto-claude/decision-index test`
   then `pnpm --filter @auto-claude/decision-index typecheck`
2. `pnpm --filter @auto-claude/sanitizer-redaction test`
   then `pnpm --filter @auto-claude/sanitizer-redaction typecheck`
3. `pnpm --filter @auto-claude/daemon test`
   then `pnpm --filter @auto-claude/daemon typecheck`
4. With Postgres up + `AUTO_CLAUDE_TEST_DATABASE_URL` (see Task 12 local-verify): the real-PG
   integration suite passes.
5. `pnpm typecheck` (root `pnpm -r typecheck`) — catch un-awaited `Promise<T>` leaks across packages
   (the most likely residual bug class).
6. `pnpm --filter @auto-claude/daemon exec vitest run src/infra/traceability-paths.test.ts` (Task 13
   validator) passes.
7. Confirm no `better-sqlite3` import remains on any RUNTIME path:
   `grep -rn "better-sqlite3" packages/*/src` should hit only the optional Task-12 export tool.

## Risk-ordered checkpoints (request review at each)

- After **Task 5** (re-entrant guarded withTx) — the deadlock/atomicity foundation.
- After **Task 6** (rowCount CAS) — the single most important correctness change.
- After **Task 9** (outbox conversion) — the bulk of the safety-critical logic.
- After **Task 11** (fail-closed/integrate behavior) — the user-visible escalation guarantee.
- After **Task 12** (real-PG cross-process proof) — the single-writer invariant.
