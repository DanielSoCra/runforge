import { defineConfig, devices } from '@playwright/test';

/**
 * Operator-surface e2e smoke (#24, D2-C scope = focused smoke + mobile).
 *
 * Boots the real Next dashboard with LOCAL_AUTH_BYPASS (a dev-only admin session,
 * never production) and DAEMON_URL pointed at the seeded mock daemon, then drives
 * the cross-layer operator flow in a real browser: inbox -> detail drawer -> answer.
 * Runs on desktop + a mobile viewport. The mock daemon makes the run deterministic;
 * no live daemon or external auth provider is needed.
 */
const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT) || 3123;
const MOCK_DAEMON_PORT = Number(process.env.MOCK_DAEMON_PORT) || 9899;
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
      command: 'node e2e/mock-daemon.mjs',
      port: MOCK_DAEMON_PORT,
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
        DAEMON_URL: `http://localhost:${MOCK_DAEMON_PORT}`,
      },
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
