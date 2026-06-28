import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    root: 'src',
    // RC-3 (CI flake, 2026-06-23): under the shared self-hosted runner the cold
    // esbuild transform/eval of the large daemon.js module graph is CPU-starved
    // past the 5s default and times out (passed 100% idle; failed 12/12 under 4x
    // concurrent load). The ROOT CAUSE — loadDaemon() doing vi.resetModules()+
    // re-import on all 131 call sites — was fixed by the dailyRunState holder +
    // __resetDailyRunStateForTests() (daemon.ts), so daemon.js is now imported warm
    // once instead of cold per test. A few cold imports remain (the first import,
    // and the single vi.doMock test that re-imports inline), so this contention
    // floor is KEPT as defense-in-depth for them — a genuine hang still fails at 30s.
    //
    // The test-hygiene guard (RC-3) evaluates this exported config and fails if
    // either timeout is removed or drops below 20s, so it cannot silently regress to
    // the default. Scope is package-wide (not per-file): sibling suites can grow the
    // same vi.resetModules()+import pattern, and keeping it in the config (not a
    // per-file vi.setConfig) is what lets the guard read the *effective* values.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
