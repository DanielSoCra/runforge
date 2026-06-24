import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Playwright e2e specs (e2e/**) run via `pnpm e2e` (playwright), NOT vitest —
    // they import @playwright/test and must not be collected by the unit runner.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // RC-3 (CI flake): 13 dashboard tests re-import Next.js route handlers via
    // vi.resetModules() + dynamic import(). On the shared self-hosted runner those
    // cold esbuild transforms are CPU-starved past the 5s default and time out under
    // concurrent CI load — the same failure mode fixed for the daemon in #770. Mirror
    // its contention floor here. Enforced repo-wide by the RC-3 guard in
    // packages/daemon/src/test-hygiene.test.ts (any package using resetModules()+import()
    // must keep testTimeout/hookTimeout >= 20s). A genuine hang still fails at 30s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
