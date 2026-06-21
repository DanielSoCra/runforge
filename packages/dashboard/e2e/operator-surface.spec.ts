import { test, expect } from '@playwright/test';

/**
 * Operator-surface cross-layer smoke (#24). Drives the real browser through the
 * steering pane against the seeded mock daemon: the ranked inbox renders, the
 * per-decision detail drawer opens and shows context, and the answer affordance
 * works. Runs on both the desktop and mobile projects (the mobile viewport is the
 * "mobile pass"). Asserts the cross-layer path unit tests can't: page -> proxy
 * route -> daemonFetch -> (mock) daemon -> render.
 */
test.describe('operator surface', () => {
  test('inbox renders the seeded decision, detail drawer opens with context', async ({ page }) => {
    await page.goto('/steering');

    // The ranked inbox row (from /api/decisions/pending -> mock daemon).
    await expect(page.getByText('Merge PR #482 into main?')).toBeVisible();
    await expect(page.getByText('P1')).toBeVisible();

    // Drill down: the Details toggle fetches /api/decisions/:id and renders context.
    await page.getByRole('button', { name: /detail/i }).first().click();
    await expect(page.getByText('Touches the auth module.')).toBeVisible();
    await expect(page.getByText('The run stays parked.')).toBeVisible();
    // source link present + safe (http)
    await expect(
      page.locator('a[href="https://github.com/org/repo/issues/482"]'),
    ).toBeVisible();
    // context-first: never implies a QA verdict
    await expect(page.locator('body')).not.toContainText(/\b(QA|passed|ready)\b/);
  });

  test('answering a decision posts through the mock daemon and confirms', async ({ page }) => {
    await page.goto('/steering');
    await expect(page.getByText('Merge PR #482 into main?')).toBeVisible();
    // open the per-row answer dialog (trigger aria-label="Answer")
    await page.getByRole('button', { name: 'Answer' }).first().click();
    await expect(page.getByText('Answer decision')).toBeVisible();
    // choose Approve -> POST /api/decisions/answer -> mock daemon 200 -> optimistic confirm
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await expect(page.getByText(/answered/i).first()).toBeVisible();
  });
});
