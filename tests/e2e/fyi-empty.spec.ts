import { expect, test } from '@playwright/test';

test('the grouped FYI card replaces the generic empty message when FYIs are the only messages', async ({ page }) => {
  await page.route(/\/v2\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v2/inbox') {
      return route.fulfill({ json: { rev: 1, items: [{
        item_id: 'i1', request_revision: 1, rev: 1, sender: 'app:fixture',
        message: { title: 'Project update', message_type: 'fyi' },
        chat: { available: false }, rank: { key: 'a', section: 'current', group: 'common' },
      }] } });
    }
    if (path === '/v2/me') return route.fulfill({ json: { features: {} } });
    return route.fulfill({ status: 400, json: {} });
  });

  await page.goto('/inbox#preview');
  await expect(page.getByRole('button', { name: 'Open FYIs, 1 unseen' })).toBeVisible();
  await expect(page.getByText('No messages', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Replied' }).click();
  await expect(page.getByText('Nothing replied yet', { exact: true })).toBeVisible();
});
