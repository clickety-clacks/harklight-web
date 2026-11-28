import { expect, test } from '@playwright/test';

test('labels Alarm without changing Server rank order, paging or ordinary priority', async ({ page }) => {
  let alarm: boolean | undefined = true;
  const item = (id: string, title: string, key: string, score: number, marker?: boolean) => ({
    item_id: id,
    rev: 1,
    request_revision: 1,
    sender: 'app:fixture',
    message: { title, ...(marker === undefined ? {} : { alarm: marker }) },
    chat: { available: false },
    rank: { key, score, level: 'normal', section: 'current', group: 'common' },
  });
  await page.route(/\/v2\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v2/inbox') {
      const nextPage = url.searchParams.has('page');
      const items = nextPage
        ? [item('i3', 'Later ranked', '1b', 0.8)]
        : [item('i1', 'Marked request', '0a', 0.1, alarm), item('i2', 'Higher scored request', '1a', 0.99)];
      return route.fulfill({ json: { rev: 1, items, ...(nextPage ? {} : { next_page: 'second' }) } });
    }
    if (url.pathname === '/v2/me') return route.fulfill({ json: { features: {} } });
    return route.fulfill({ status: 400, json: {} });
  });
  const row = (title: string) => page.getByTestId('row').filter({ hasText: title });
  const titles = page.getByTestId('row').locator('.t');
  const expectedOrder = ['Marked request', 'Higher scored request', 'Later ranked'];
  await page.goto('/inbox');
  await expect(titles).toHaveText(expectedOrder);
  await expect(row('Marked request').locator('.row-meta')).toContainText('Alarm');
  await expect(row('Higher scored request').locator('.row-meta')).toContainText('Urgent');
  await expect(row('Later ranked').locator('.row-meta')).toContainText('High priority');

  alarm = false;
  await page.reload();
  await expect(titles).toHaveText(expectedOrder);
  await expect(row('Marked request').locator('.row-meta')).toHaveCount(0);
});
