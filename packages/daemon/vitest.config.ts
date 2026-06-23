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
    // (RC-3) locks these in so they cannot silently regress to the default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
