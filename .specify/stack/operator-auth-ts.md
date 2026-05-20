---
id: STACK-AC-OPERATOR-AUTH
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-OPERATOR-AUTH
code_paths:
  - packages/auth/**
  - packages/dashboard/lib/auth/**
  - packages/dashboard/app/api/auth/**
  - packages/dashboard/app/(auth)/**
test_paths:
  - packages/auth/**/*.test.ts
  - packages/dashboard/lib/auth/**/*.test.ts
  - packages/dashboard/app/api/auth/**/*.test.ts
---

# STACK-AC-OPERATOR-AUTH — Operator Auth Service (TypeScript)

## Pattern

**Better Auth with the Drizzle adapter + a server-side `require-session` gate fronting a pure `gateDecision` predicate, with an app-owned `role` column.** Modeled on the `acme/apps/ops` auth shape (`betterAuth({ database: drizzleAdapter(db, { provider: 'pg' }) })`, server-only `require-session.ts`, a pure decision function, `advanced.database.generateId: 'uuid'`).

Chosen over a hand-rolled session system (security risk, the issue forbids weakening auth) and over keeping storage-layer RLS for authorization (the issue mandates moving authorization into the application). Better Auth gives project-owned `users`/`sessions`/`accounts`/`verifications` tables created through our own migrations, and the pure predicate keeps the gate unit-testable.

## Key Decisions

- **Better Auth + Drizzle adapter** — auth tables defined in the shared `packages/db` schema but **created by the Data Platform Migration Runner** (STACK-AC-DATA-PLATFORM owns ordering; this spec owns their definition and semantics).
- **Server-side enforcement only** — a `requireSession()` in route handlers and server components; the client-asserted role is never trusted. Daemon control routes sit behind an admin-only variant.
- **Pure `gateDecision` predicate** — `(session, { localBypass }) → '/login' | null | 'deny'`; no I/O, fully unit-tested, mirrors the acme `gate-decision.ts` split.
- **App-owned `role`** — `administrator | viewer` on the membership/user record, enforced in application code; Supabase `is_admin()`/`is_member()` SQL and all RLS policies are removed.
- **`AUTH_DISABLED` → `LOCAL_AUTH_BYPASS`** — the blunt switch is replaced by a named local-only bypass that activates only when an explicit local flag is set **and** no production indicator (`NODE_ENV=production`, deploy markers) is present; it refuses in production and logs the refusal.
- **Continuity** — preserve first-user-is-admin bootstrap and the invitation flow; `team_members` / `invitations` semantics carry over with documented operator migration.
- **Login provider** — keep GitHub OAuth as a Better Auth social provider so the existing operator import path is preserved; an email/password equivalent is acceptable only if documented and tested with explicit access continuity. (Login OAuth is distinct from daemon repo-access connection tokens, which belong to STACK-AC-DATA-PLATFORM `CredentialStore`.)

## Examples

```ts
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
  advanced: { database: { generateId: 'uuid' } },
});
```

```ts
// pure, testable gate
export function gateDecision(s: Session | null, o: { localBypass: boolean }) {
  if (o.localBypass) return null;
  return s ? null : '/login';
}
```

```ts
// refuse on ANY production indicator (NODE_ENV, deploy markers), not just one
export const localBypass =
  env.LOCAL_AUTH_BYPASS === 'true' && !hasProductionIndicator(env);
```

## Gotchas

- **Bypass must be impossible in production.** Gate on both the explicit flag and the *absence* of any production indicator; default to enforced auth if the environment is ambiguous (fail closed).
- **Never trust a client-supplied role.** Resolve role from the server-side session on every privileged call; no role in cookies/localStorage drives authorization.
- **Auth tables: semantics here, physical creation in Data Platform.** Coordinate migration ordering — auth tables must exist before the first sign-in but are emitted by the shared migration runner, not a separate auth migrator.
- **Preserve admin/viewer parity exactly.** Map existing `team_members.role` values 1:1; a viewer must remain unable to mutate repo/daemon/team/settings after cutover.
- **Login OAuth ≠ repo-access tokens.** Dashboard sign-in via GitHub is identity; the daemon's GitHub repo tokens are credentials in STACK-AC-DATA-PLATFORM. Conflating them silently breaks imports or token use.
- **Bootstrap race.** First-administrator establishment must be atomic (single-winner) so concurrent fresh-deployment sign-ins cannot create two administrators.
- **Session cookie name/expiry.** Set an explicit cookie name and expiry; do not inherit a default that collides with other services on the same host.
