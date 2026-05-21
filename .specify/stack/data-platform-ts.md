---
id: STACK-AC-DATA-PLATFORM
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DATA-PLATFORM
code_paths:
  - packages/db/**
  - packages/dashboard/lib/data/**
  - packages/daemon/src/data/**
  - packages/briefing-summarizer/src/data/**
  - infra/postgres/**
test_paths:
  - packages/db/**/*.test.ts
  - packages/dashboard/lib/data/**/*.test.ts
  - packages/daemon/src/data/**/*.test.ts
---

# STACK-AC-DATA-PLATFORM — Self-Hosted Data Service (TypeScript)

## Pattern

**Strangler Fig + Store-adapter seam over Drizzle-managed Postgres 18, container-orchestrated with Docker Compose.** Modeled on the `acme/apps/ops` shape (Compose-managed `postgres:18-alpine`, `drizzle.config.ts` + forward-only `drizzle/` SQL migrations, pooled `postgres-js` clients with lazy per-pool env validation, a `run-migrations.ts` invoked before app start).

Chosen over a big-bang rewrite (unacceptable blast radius on a live system) and over keeping any hosted database (the issue mandates self-hosted ownership). The strangler seam lets each caller swap from the `@supabase/*` client to a typed Store while the hosted provider stays authoritative until an explicit cutover, satisfying the staged FUNC-AC-DATA-PLATFORM behavior.

## Key Decisions

- **Postgres 18 via Compose** — `postgres:18-alpine` service with `pg_isready` healthcheck, a named volume for persistence, and a one-shot migrate job; app services use `depends_on: { condition: service_healthy }`.
- **Drizzle ORM + drizzle-kit** — forward-only SQL migrations tracked in `drizzle/meta/_journal.json`; schema authored under a shared `packages/db` workspace package consumed by dashboard, daemon, and briefing-summarizer.
- **`postgres-js` pooled client, lazy env validation** — `readDbUrl()` validates the connection URL on first use, not at import; missing/partial config fails fast with no silent fallback (replaces the current "Supabase null → legacy file config" branch with an explicit error).
- **Typed Store modules** — `RepoStore`, `RunStore`, `CostEventStore`, `CredentialStore`, `PluginStore`, `BriefingStore`, `SettingsAccess` replace direct Supabase calls; each is the only seam callers depend on, enabling per-caller cutover. `RunStore` includes daemon restart and retry-cap read operations (`markInProgressRunsStuck`, `countStuckRunsForIssue`) so the Agent Service does not reach around the Store boundary during cutover. `BriefingStore` includes both append operations and the read-side operations the standalone summarizer needs (`readLatestBriefing`, `listRunsForSignals`, `countNotificationChannels`) so it does not reach around the Store boundary during the migration.
- **CredentialStore crypto** — `node:crypto` AES-256-GCM with a per-record random 12-byte IV, the record id (connection id, or `repoId:kind`) as additional authenticated data, and a versioned ciphertext envelope. The master key comes from a required `ENCRYPTION_KEY` runtime secret; there is **no generated fallback key** and startup fails if it is absent. This replaces **all** Supabase vault `SECURITY DEFINER` credential RPCs in a single app-owned crypto path: `store_github_connection`, `decrypt_github_token`, `upsert_api_key_encrypted`, and `decrypt_api_key`. Fail-closed `ENCRYPTION_KEY` handling applies to every credential kind — GitHub connection tokens and per-repo `source-control` / `model-provider` / `webhook-secret` keys alike — so no credential family is left on a hosted RPC.
- **Backup/Restore** — `pg_dump` / `pg_restore` against the Compose Postgres volume; documented operator commands, no proprietary export.
- **Migration runner** — `run-migrations.ts` with a single-connection `postgres-js` pool, run from the Compose migrate job before any consumer starts; it also creates the Operator Authorization tables (coordination owned here, semantics owned by STACK-AC-OPERATOR-AUTH).
- **Store error wrapping preserves cause and category.** `unavailableOnThrow()` in `packages/db/src/postgres-stores.ts` is the single seam where driver errors become `StoreResult` outcomes. It must (a) walk the `error.cause` chain and pick the **deepest** layer that carries a `code` (e.g. `ECONNREFUSED`, `28P01`, `42P01`) or a non-default `name`/`class`; if every layer is opaque, fall back to the outermost `message`; (b) record `{ class, code, message }` of the chosen layer as structured fields on the `unavailable` result; (c) classify the result as `unreachable` (network errnos `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / `ECONNRESET`; postgres SQLSTATE class `08*`) versus `rejected` (`28*` auth, `42*` syntax/schema, `2BP01` dependent privilege, `42501` permission); if the chosen layer has neither an errno nor a SQLSTATE that matches the above, the result defaults to `rejected` — a `rejected` outcome surfaces to the Operator immediately and does not silently consume the retry budget. Consumers branch on category rather than parsing text. (d) format the human-readable message as `<SQL summary> — <code>: <chosen-layer message>` rather than only the SQL. Drizzle's `Failed query: <SQL>` wrapper alone is insufficient — the underlying cause is what an Operator needs.

## Examples

```ts
// packages/db: lazy, fail-fast pool — no hosted fallback
const sql = postgres(readDbUrl(), { max: 14 });
export const db = drizzle(sql, { schema });
```

```ts
// CredentialStore envelope: AES-256-GCM, per-record IV, id as AAD
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', key, iv).setAAD(
  Buffer.from(connectionId),
);
const blob = Buffer.concat([c.update(token), c.final()]);
return { v: 1, iv, tag: c.getAuthTag(), blob };
```

```yaml
# infra/postgres compose stanza (shape only)
postgres:
  { image: postgres:18-alpine, healthcheck: { test: ['CMD', 'pg_isready'] } }
migrate:
  {
    depends_on: { postgres: { condition: service_healthy } },
    command: ['node', 'run-migrations.js'],
  }
```

## Gotchas

- **Schema parity is from the full history, not the live snapshot.** Derive the Drizzle schema from all 13 `supabase/migrations/*` files, including later additions: `repos.credential_status`/`credential_error` (013), `repos.matrix_status` and the `webhook-secret` `key_type` value (004), `repos.github_status` (005), `runs.updated_at` (012), the `failed` run-outcome enum value (011), `global_settings.default_model` (007), `repo_plugins.config` and the `plugin_global_settings` table (006), the per-repo `api_keys` table with its `key_type` kinds `source-control`/`model-provider`/`webhook-secret` (001 + 004), and the `briefings`/`activity_events`/`github_orgs`/`notification_channel_configs` tables (005/009). A snapshot-only port will silently lose columns, enum values, and entire tables.
- **Never run the hosted provider and the project store as co-authoritative.** Parity uses one source of truth; cutover is a single switch. No dual-write that can diverge.
- **`NEXT_PUBLIC_*` are build-time inlined.** Removing Supabase public env requires a dashboard rebuild, not just a restart; track this in the Compose build args.
- **AES-256-GCM nonce uniqueness.** A reused IV under the same key breaks confidentiality; persist `{v, iv, tag, blob}` together and reject envelopes with an unknown version.
- **Migrations strictly precede consumers.** The migrate job must complete before dashboard/daemon start; relying only on `depends_on: service_healthy` (Postgres up) is not enough — gate on the migrate job exit.
- **Repo-access tokens are not login.** `CredentialStore` holds GitHub _repo-access_ connection tokens used by the daemon; it must not be conflated with dashboard _login_ (owned by STACK-AC-OPERATOR-AUTH) — conflating them silently breaks imports or token use.
- **`postgres-js` pool sizing.** Advisory-lock-heavy workloads need headroom; size the pool deliberately and document it rather than defaulting blindly.
- **Drizzle's `Failed query: <SQL>` is not a cause.** The wrapped `PostgresError` carries the SQL and parameters but discards the driver's underlying `cause` if you only read `error.message`. Connection failures (`ECONNREFUSED`), authentication failures (`28P01`), and missing-table failures (`42P01`) all surface as the same opaque "Failed query" string unless `unavailableOnThrow` walks `error.cause` and records the class and code separately.
