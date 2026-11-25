import { expect, test } from '@playwright/test';

test('reports the screen on navigation and reports signed out before the browser session ends', async ({ page }) => {
  await page.request.post('/__fake/reset');
  await page.setViewportSize({ width: 390, height: 800 });
  const title = 'Which hotel should I book for Lisbon?';
  const lastReport = async () => {
    const state = await page.request.post('/__fake/state').then((r) => r.json());
    return state.focusReports?.at(-1);
  };
  const named = { ttl_s: 120, device_name: expect.stringMatching(/^Web, Chrome on /) };

  await page.goto('/inbox');
  await expect.poll(lastReport).toEqual({ screen: 'inbox', ...named });
  await page.getByTestId('row').filter({ hasText: title }).first().click();
  await expect.poll(lastReport).toEqual({ screen: 'message', item_id: expect.any(String), ...named });
  const id = (await lastReport()).item_id;
  await page.getByRole('button', { name: /^Chat(?:,|$)/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(lastReport).toEqual({ screen: 'chat', item_id: id, ...named });
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect.poll(lastReport).toEqual({ screen: 'message', item_id: id, ...named });
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect.poll(lastReport).toEqual({ screen: 'inbox', ...named });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect.poll(lastReport).toEqual({ screen: 'settings', ...named });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/account\/sign-out$/);
  expect(await lastReport()).toEqual({ screen: 'signed_out', ttl_s: 120 });
});
