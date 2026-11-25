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

for (const channel of ['BroadcastChannel', 'storage']) {
  test(`hands off focus across tabs via ${channel} and serializes their PUTs`, async ({ page, context }) => {
    await page.request.post('/__fake/reset');
    await context.addInitScript(({ fallback }) => {
      if (fallback) Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
      else Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Storage unavailable', 'SecurityError'); },
      });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    }, { fallback: channel === 'storage' });

    const foreground = (tab: typeof page, onVisibility = false) => tab.evaluate((visibility) => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      if (visibility) document.dispatchEvent(new Event('visibilitychange'));
      else window.dispatchEvent(new Event('focus'));
    }, onVisibility);
    const hide = async (tab: typeof page) => tab.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const other = await context.newPage();
    await page.goto('/inbox');
    await other.goto('/settings');
    await expect(page.getByTestId('row').first()).toBeVisible();
    await expect(other.getByTestId('connection-status')).toHaveText('Connected');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    await context.route('**/v2/devices/me/focus', async (route) => {
      const { screen } = route.request().postDataJSON();
      sent.push(screen);
      if (sent.length === 1) await hold;
      await route.continue();
    });
    try {
      await foreground(page);
      await expect.poll(() => sent.slice()).toEqual(['inbox']);
      await foreground(other);
      await hide(page);
      // Give the background handoff time to settle while the first PUT is held.
      await expect.poll(() => other.evaluate(() => navigator.locks.query().then((locks) => locks.pending?.length))).toBe(1);
      expect(sent).toEqual(['inbox']);
      release();
      await expect.poll(() => sent.slice()).toEqual(['inbox', 'settings']);
      await foreground(page, true);
      await hide(other);
      await expect.poll(() => sent.slice()).toEqual(['inbox', 'settings', 'inbox']);
    } finally {
      release();
    }
  });
}
