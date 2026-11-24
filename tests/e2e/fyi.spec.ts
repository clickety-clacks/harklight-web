import { expect, test } from '@playwright/test';

test('FYI preview, full list and Seen actions at phone width using the keyboard', async ({ page }) => {
  await page.request.post('/__fake/reset');
  await page.setViewportSize({ width: 320, height: 700 });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(answer|seen)$/.test(new URL(request.url()).pathname)) {
      writes.push(request.url());
    }
  });

  // Move FYIs across pages and make priority differ from posting order.
  await page.route(/\/v2\/inbox(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '2');
    const response = await route.fetch({ url: url.href });
    const json = await response.json();
    for (const item of json.items) {
      if (item.message.title === 'The hosting card expires next month') {
        item.rank.level = 'high';
        item.rank.score = 0.8;
      }
      if (item.message.title === 'Quarterly report is ready') delete item.message.answer_ui;
    }
    await route.fulfill({ response, json });
  });
  await page.goto('/inbox#preview');
  const summary = page.getByRole('button', { name: 'Open FYIs, 2 unseen' });
  await expect(summary).toContainText('Nine meetings, two of them moved.');
  await expect(page.getByTestId('row').filter({ hasText: 'Quarterly report is ready' })).toHaveCount(0);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'FYI', exact: true })).toBeFocused();
  const headings = page.getByRole('heading', { level: 2 });
  await expect(headings.first()).toHaveText('The hosting card expires next month');
  await expect(page.getByText('Renewals after December 1 will fail unless the card is replaced.')).toBeVisible();
  await page.getByRole('button', { name: 'Sort: Priority' }).press('Space');
  await expect(headings.first()).toHaveText('Your week ahead');
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  await page.getByRole('button', { name: 'Mark seen: Quarterly report is ready' }).press('Enter');
  const report = page.getByRole('article').filter({ hasText: 'Quarterly report is ready' });
  await expect(report.getByText('Seen', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Inbox' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Open FYIs, 1 unseen' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Mark All Seen' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Mark All Seen' })).toBeDisabled();
  await expect(page.getByRole('article').filter({ hasText: 'The hosting card expires next month' }).getByText('Seen', { exact: true })).toBeVisible();
  await expect(headings).toHaveCount(3);
  expect(writes.map((url) => new URL(url).pathname.split('/').at(-1))).toEqual(['seen', 'answer']);
  await page.getByRole('button', { name: 'Back to Inbox' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Open FYIs, 0 unseen' })).toBeVisible();
});
