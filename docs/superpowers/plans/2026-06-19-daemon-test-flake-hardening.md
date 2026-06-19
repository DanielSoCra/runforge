# Plan: Daemon test-suite concurrent-load flake hardening

**Date:** 2026-06-19
**Author:** Claude (sparring-driven-development, claude-fallback binding, full-auto)
**Adversary/reviewer:** Codex GPT-5.5 high (codex-on-diff, per PR)

## Problem (reproduced empirically)

GitHub Actions over the last 24h: **0 hard failures** (2 `cancelled` runs = concurrency
cancellations, benign). The real signal is **flaky tests under concurrent load** — the
shared self-hosted runner runs multiple branch CIs + the autonomous daemon's own `pnpm test`
gate simultaneously.

Reproduction: 4× concurrent `pnpm --filter @auto-claude/daemon test`.
Idle = 3132/3132 green. Under 4× load = **112 failures across 3 files, 2 root causes**:

| Root cause | Files (reproduced + latent) | Mechanism |
|---|---|---|
| RC-1 fixed TCP ports | `server.test.ts` (72), `cli.test.ts` (29); latent `degraded-server.test.ts`, `main.test.ts` | hard-coded `PORT = 19876/19877/47821/19899` → concurrent processes collide → `start()` returns `EADDRINUSE` → `expect(result.ok).toBe(true)` cascades |
| RC-2 non-unique temp paths | `generate-containment-script.test.ts` (11); latent `plugin-registry`, `containment-hooks`, `offload`, `plugin-loader`, `config` | `test-hook-${Date.now()}.mjs` etc. in shared `/tmp` → same-ms cross-process collision → `unlinkSync` throws `ENOENT` |

(`src/some-unrelated/flaky.test.ts` in logs is a fixture *string* in `stuck-escalation.repro.test.ts`, not a real file.)

## Fixes (3 PRs)

### PR1 — Ephemeral ports (`fix/test-ephemeral-ports`)
Bind every test server to **port 0** and read the OS-assigned port back via
`(server.address() as AddressInfo).port`; use that port in `fetch`/CLI args.
- Files: `server.test.ts`, `cli.test.ts`, `degraded-server.test.ts`, `main.test.ts`.
- **Semantics tests preserved:** "rejects second instance on same port" → bind A on 0, read port P, bind B on **P**, expect fail. "allows immediate rebind after close" → bind on 0, read P, close, rebind on **P**, expect ok.
- Production code (`createControlServer`, `createDegradedServer`) is **unchanged** — `port` is only used for log/error strings; the bound port is authoritative.
- Oracle: `daemon` suite green idle **and** under 4× concurrent load; `server.test.ts`+`cli.test.ts` no longer fail.

### PR2 — Unique temp dirs (`fix/test-unique-tempdirs`)
Replace `Date.now()`/fixed-name temp paths with `mkdtempSync(join(tmpdir(), '<prefix>-'))`
(guaranteed-unique dir) + `rmSync(dir, { recursive: true, force: true })` cleanup in
try/finally or afterEach. Guard any direct `unlinkSync` with `force` / existence.
- Files: `generate-containment-script.test.ts`, `plugin-registry.test.ts`, `containment-hooks.test.ts`, `offload.test.ts`, `plugin-loader.test.ts`, `decision-escalation/config.test.ts`.
- Oracle: `generate-containment-script.test.ts` no longer ENOENT-fails under 4× load.

### PR3 — Regression guard (`fix/test-hygiene-guard`) — merges AFTER 1 & 2
A self-contained meta-test (`packages/daemon/src/test-hygiene.test.ts`) that scans
`**/*.test.ts` and fails if a test reintroduces (a) a hard-coded 4–5 digit port literal
bound via `listen(`/`createControlServer(`/`createDegradedServer(`, or (b) a `${Date.now()}`
fragment inside a `tmpdir()` path. Locks in RC-1/RC-2 so they can't silently return.
- Depends on 1 & 2 (the guard is red against today's `main`); sequence merges ports → tempdirs → guard.

## Verification oracle (the real target)
Not "CI green" — the **suite under 4× concurrent load**. Each PR: targeted file green idle →
full daemon suite green idle → 4× concurrent daemon suite green (was red). Final Phase-9
check on merged `main`. Captured in the execution log.

## Codex plan-review (incorporated, 2026-06-19)
Adversarial review (Codex GPT-5.5 high) confirmed the approach sound; corrections folded in:
- **C1:** `port 0` + `exclusive:true` is correct; `server.address()` is populated after `await start()` (Promise resolves in the `listen` callback). Always capture numeric `P` before forwarding to any `fetch`/CLI — never pass `0` to a client.
- **C2:** the "rebind after close (SO_REUSEADDR)" test never issues an HTTP request, so it only proves *re-listen after close*. Keep the captured-P rebind but **correct the misleading comment**.
- **C3:** real race — after close, another process may snatch `P` before rebind (bites under the 4× oracle). Wrap that single test's allocate→close→rebind in a **bounded `EADDRINUSE` retry** (fresh ephemeral P on collision).
- **C6:** `cli.test.ts` — capture readback `port` into a per-test variable before `parseAsync`; error-path assertions use captured `P`.
- **C5:** the meta-test must be token-scoped (strip comments, match only real `createControlServer(`/`createDegradedServer(`/`.listen(` call sites with digit literals; allow `0`) to avoid false positives on comments/fixtures.

## Out of scope
No production-code changes. No vitest-config concurrency hacks (don't fix cross-*process*
collisions). No new feature → no L1/L2/L3 chain; no `traceability.yml` change (editing
existing covered test files; PR3 adds one test file under the daemon package's existing glob).
