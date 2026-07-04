import { test, expect } from '@playwright/test';

/**
 * Operator-surface cross-layer smoke (#24). Drives the real browser through the
 * steering pane against the REAL daemon control-plane + decision-api handlers
 * over a seeded in-memory read model: the ranked inbox renders, the per-decision
 * detail drawer opens and shows context, and the answer affordance works end-to-end.
 * Runs on both the desktop and mobile projects.
 */

const TEST_INTROSPECTION_URL = 'http://127.0.0.1:9900';

test.describe('operator surface', () => {
  // The e2e daemon is a single long-lived process; the answer flow mutates its
  // in-memory read model. Re-seed before every test (and every retry) so each
  // test starts from the known two-decision fixture.
  test.beforeEach(async ({ request }) => {
    await request.post(`${TEST_INTROSPECTION_URL}/reset`);
  });

  test('inbox renders the seeded decision, detail drawer opens with context', async ({ page }) => {
    await page.goto('/steering');

    // The ranked inbox row (from /api/decisions/pending -> real daemon).
    await expect(page.getByText('Approve seeded decision 42?')).toBeVisible();
    await expect(page.getByText('P1').first()).toBeVisible();

    // Drill down: the Details toggle fetches /api/decisions/:id and renders context.
    await page.getByRole('button', { name: 'Details' }).first().click();
    await expect(page.getByText('Seeded context for issue 42')).toBeVisible();
    await expect(page.getByText('The run remains parked.')).toBeVisible();
    // source link present + safe (http)
    await expect(
      page.locator('a[href="https://github.com/acme/widgets/issues/42"]'),
    ).toBeVisible();
    // context-first: never implies a QA verdict
    await expect(page.locator('body')).not.toContainText(/\b(QA|passed|ready)\b/);
  });

  test('answering a decision posts through the real daemon and the row leaves', async ({ page }) => {
    await page.goto('/steering');
    await expect(page.getByText('Approve seeded decision 42?')).toBeVisible();

    // open the per-row answer dialog (trigger aria-label="Answer")
    await page.getByRole('button', { name: 'Answer' }).first().click();
    await expect(page.getByText('Answer decision')).toBeVisible();

    // choose Approve -> POST /api/decisions/answer -> real daemon 200 -> optimistic confirm
    // Anchor on the network round-trip: install the response wait BEFORE the
    // click so it cannot race, and assert the POST succeeded — a missing
    // badge is then attributable (POST failed/hung vs UI regression).
    const [answerResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/decisions/answer') &&
          res.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Approve' }).first().click(),
    ]);
    expect(answerResponse.ok()).toBe(true);
    await expect(page.getByText(/answered/i).first()).toBeVisible();

    // After the next periodic refresh, the answered row is gone from the real read model.
    await expect(page.getByText('Approve seeded decision 42?')).not.toBeVisible();
    // The second seeded decision remains.
    await expect(page.getByText('Approve seeded decision 43?')).toBeVisible();
  });

  test('admin halts the daemon via UI and the real control plane records it', async ({ page }) => {
    await page.goto('/steering');

    // Halt is admin-only; LOCAL_AUTH_BYPASS gives an admin session in e2e.
    await page.getByRole('button', { name: 'Halt' }).click();
    await expect(page.getByText('Confirm halt')).toBeVisible();
    await page.getByRole('button', { name: 'Halt now' }).click();

    // The UI surfaces the halt response summary.
    await expect(page.getByText(/Halted: \d+ parked, \d+ terminated, \d+ escalated/)).toBeVisible();

    // The real daemon recorded POST /halt in the test introspection endpoint.
    const haltLog = await page.evaluate(async () => {
      const res = await fetch('http://127.0.0.1:9900/halt-log');
      return res.json();
    });
    expect(Array.isArray(haltLog)).toBe(true);
    expect(haltLog.length).toBeGreaterThanOrEqual(1);
  });
});
