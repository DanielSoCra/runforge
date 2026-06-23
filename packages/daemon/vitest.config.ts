import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    root: 'src',
    // RC-3 (CI flake, 2026-06-23): several daemon tests re-import the large
    // daemon.js module graph via loadDaemon() (vi.resetModules() + dynamic
    // import). On the shared self-hosted runner the daemon's own `pnpm test`
    // gate runs concurrently with branch CIs, and the cold esbuild
    // transform/eval of that graph is starved well past the 5s default,
    // timing out the FIRST loadDaemon() test (passes 100% idle; failed 12/12
    // under 4x concurrent load). The test is not hung — it completes, just
    // slowly under contention — so the principled fix is contention headroom,
    // not masking; a genuine hang still fails at 30s. The test-hygiene guard
    // (RC-3) evaluates this exported config and fails if either timeout is
    // removed or drops below 20s, so it cannot silently regress to the default.
    //
    // Scope is deliberately package-wide rather than per-file: the cold-import
    // cost lands on whichever loadDaemon()-style test runs first (ordering is not
    // stable), and sibling suites can grow the same vi.resetModules()+import
    // pattern. Package-wide is robust to both; the cost is a bounded masking of
    // future 20-30s tests, acceptable on a contended self-hosted gate (a >30s
    // hang still fails). Keeping it in the config (not a per-file vi.setConfig)
    // is also what lets the RC-3 guard evaluate the *effective* values.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
