import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeOldHistory } from '../history-observations';

const inventory = process.env.UPGRADE_HISTORY_INVENTORY;
test.skip(!inventory, 'Requires the pre-upgrade Server fixture');

for (const version of ['0.2.0', '0.2.16', '0.2.28']) {
  test(`render migrated Server ${version} projections in Web: old message, Chat and answer`, async ({ page }) => {
    const original = JSON.parse(readFileSync(join(inventory!, '0.1.49.json'), 'utf8'));
    const { items, projections } = JSON.parse(readFileSync(join(inventory!, `${version}.json`), 'utf8'));
    const messagesAndHistory = (rows: { message: object; facts: object[] }[]) =>
      rows.map(({ message, facts }) => ({ message, facts }));
    expect(messagesAndHistory(items)).toEqual(messagesAndHistory(original.items));
    expect(original.items.find((item: { message_id: string }) => item.message_id === 'answered').terminal)
      .toMatchObject({ answer: 'Synthetic answer' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route(/\/v2\//, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/v2/inbox') return route.fulfill({ json: projections.browser_inbox });
      const match = pathname.match(/^\/v2\/items\/([^/]+)\/entries$/);
      const records: { id: string; entries: object }[] = Object.values(projections.browser_item_reads);
      const record = match && records.find((entry) => entry.id === match[1]);
      if (record) return route.fulfill({ json: record.entries });
      if (pathname === '/v2/me') return route.fulfill({ json: { features: {} } });
      return route.fulfill({ status: 400, json: {} });
    });
    await page.goto('/inbox');
    await observeOldHistory(page);
  });
}
