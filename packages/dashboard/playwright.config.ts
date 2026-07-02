import { defineConfig, devices } from '@playwright/test';

/**
 * Operator-surface e2e smoke (#24, D2-C scope = focused smoke + mobile).
 *
 * Boots the real Next dashboard with LOCAL_AUTH_BYPASS (a dev-only admin session,
 * never production) and DAEMON_URL pointed at the REAL daemon control-plane boot
 * script (real-daemon.mjs). The boot script seeds an in-memory read model and
 * wires the real decision-api handlers, so the smoke exercises the true cross-
 * layer path (browser -> dashboard proxy route -> daemonFetch -> real daemon).
 */
const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT) || 3123;
const REAL_DAEMON_PORT = Number(process.env.REAL_DAEMON_PORT) || 9899;
const BASE_URL = `http://localhost:${DASHBOARD_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { baseURL: BASE_URL, trace: 'on-first-retry' },
  webServer: [
    {
      command: 'pnpm --filter @auto-claude/daemon exec tsx ../dashboard/e2e/real-daemon.mjs',
      port: REAL_DAEMON_PORT,
      reuseExistingServer: process.env.CI !== 'true',
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `next dev -p ${DASHBOARD_PORT}`,
      port: DASHBOARD_PORT,
      reuseExistingServer: process.env.CI !== 'true',
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        LOCAL_AUTH_BYPASS: 'true',
        DAEMON_URL: `http://localhost:${REAL_DAEMON_PORT}`,
        // Short refresh interval for e2e so the periodic poll removes answered
        // rows quickly without waiting the production 30s default.
        NEXT_PUBLIC_REFRESH_INTERVAL_MS: '250',
      },
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
