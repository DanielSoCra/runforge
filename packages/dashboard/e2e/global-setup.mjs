// Playwright global setup: warm `next dev`'s on-demand route compilation before
// any timed smoke assertion runs.
//
// Why: the operator-surface smoke drives `next dev`, which compiles a route the
// first time it is requested. On the self-hosted CI runner — under the same
// concurrent load that drives the RC flake class — that first-hit compilation of
// the /steering page and the decision API routes intermittently overran the 10s
// `expect` window, so the very first `toBeVisible()` timed out even though the
// in-memory daemon answers instantly (CI flake, run 28616577086, 2026-07-02).
//
// Compiling the hot routes once up front (best-effort, before any test's tight
// visibility window opens) removes that race. It pairs with the raised expect/
// test timeouts + extra CI retry in playwright.config.ts, which absorb the
// residual raw-contention spikes that no warm-up can eliminate.
const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT) || 3123;
const BASE_URL = `http://localhost:${DASHBOARD_PORT}`;

async function warm(path) {
  try {
    // Playwright starts the webServers and waits for their ports before running
    // globalSetup, so the port is open here — but `next dev` still compiles the
    // route on this first request. Auth/query outcome is irrelevant; the GET is
    // enough to trigger (and await) compilation.
    const res = await fetch(`${BASE_URL}${path}`);
    await res.text().catch(() => {});
  } catch {
    // Best-effort only: if warming fails, each test still has its own (raised)
    // timeout and retries as the safety net. Never fail the whole run on warm-up.
  }
}

export default async function globalSetup() {
  await warm('/steering');
  await warm('/api/decisions/pending');
}
