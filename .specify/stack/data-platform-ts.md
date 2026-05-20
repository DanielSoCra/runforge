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
- **Typed Store modules** — `RepoStore`, `RunStore`, `CostEventStore`, `CredentialStore`, `PluginStore`, `BriefingStore`, `SettingsAccess` replace direct Supabase calls; each is the only seam callers depend on, enabling per-caller cutover.
- **CredentialStore crypto** — `node:crypto` AES-256-GCM with a per-record random 12-byte IV, the record id (connection id, or `repoId:kind`) as additional authenticated data, and a versioned ciphertext envelope. The master key comes from a required `ENCRYPTION_KEY` runtime secret; there is **no generated fallback key** and startup fails if it is absent. This replaces **all** Supabase vault `SECURITY DEFINER` credential RPCs in a single app-owned crypto path: `store_github_connection`, `decrypt_github_token`, `upsert_api_key_encrypted`, and `decrypt_api_key`. Fail-closed `ENCRYPTION_KEY` handling applies to every credential kind — GitHub connection tokens and per-repo `source-control` / `model-provider` / `webhook-secret` keys alike — so no credential family is left on a hosted RPC.
- **Backup/Restore** — `pg_dump` / `pg_restore` against the Compose Postgres volume; documented operator commands, no proprietary export.
- **Migration runner** — `run-migrations.ts` with a single-connection `postgres-js` pool, run from the Compose migrate job before any consumer starts; it also creates the Operator Authorization tables (coordination owned here, semantics owned by STACK-AC-OPERATOR-AUTH).

## Examples

```ts
// packages/db: lazy, fail-fast pool — no hosted fallback
const sql = postgres(readDbUrl(), { max: 14 });
export const db = drizzle(sql, { schema });
```

```ts
// CredentialStore envelope: AES-256-GCM, per-record IV, id as AAD
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(connectionId));
const blob = Buffer.concat([c.update(token), c.final()]);
return { v: 1, iv, tag: c.getAuthTag(), blob };
```

```yaml
# infra/postgres compose stanza (shape only)
postgres: { image: postgres:18-alpine, healthcheck: { test: ["CMD","pg_isready"] } }
migrate:  { depends_on: { postgres: { condition: service_healthy } }, command: ["node","run-migrations.js"] }
```

## Gotchas

- **Schema parity is from the full history, not the live snapshot.** Derive the Drizzle schema from all 13 `supabase/migrations/*` files, including later additions: `repos.credential_status`/`credential_error` (013), `repos.matrix_status` and the `webhook-secret` `key_type` value (004), `repos.github_status` (005), `runs.updated_at` (012), the `failed` run-outcome enum value (011), `global_settings.default_model` (007), `repo_plugins.config` and the `plugin_global_settings` table (006), the per-repo `api_keys` table with its `key_type` kinds `source-control`/`model-provider`/`webhook-secret` (001 + 004), and the `briefings`/`activity_events`/`github_orgs`/`notification_channel_configs` tables (005/009). A snapshot-only port will silently lose columns, enum values, and entire tables.
- **Never run the hosted provider and the project store as co-authoritative.** Parity uses one source of truth; cutover is a single switch. No dual-write that can diverge.
- **`NEXT_PUBLIC_*` are build-time inlined.** Removing Supabase public env requires a dashboard rebuild, not just a restart; track this in the Compose build args.
- **AES-256-GCM nonce uniqueness.** A reused IV under the same key breaks confidentiality; persist `{v, iv, tag, blob}` together and reject envelopes with an unknown version.
- **Migrations strictly precede consumers.** The migrate job must complete before dashboard/daemon start; relying only on `depends_on: service_healthy` (Postgres up) is not enough — gate on the migrate job exit.
- **Repo-access tokens are not login.** `CredentialStore` holds GitHub *repo-access* connection tokens used by the daemon; it must not be conflated with dashboard *login* (owned by STACK-AC-OPERATOR-AUTH) — conflating them silently breaks imports or token use.
- **`postgres-js` pool sizing.** Advisory-lock-heavy workloads need headroom; size the pool deliberately and document it rather than defaulting blindly.
