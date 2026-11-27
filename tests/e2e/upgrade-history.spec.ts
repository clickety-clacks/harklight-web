import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const inventory = process.env.UPGRADE_HISTORY_INVENTORY;
test.skip(!inventory, 'Requires the pre-upgrade Server fixture');

// The pinned Server fixture serializes direct reads using Elixir inspect.
function decode(inspected: string) {
  if (!inspected.startsWith('{:ok, %{') || !inspected.endsWith('}}')) throw new Error('Unexpected fixture encoding');
  return JSON.parse(inspected.slice(6, -1).replace(/%\{/g, '{').replace(/"\s*=>/g, '":').replace(/\bnil\b/g, 'null'));
}

for (const version of ['0.2.0', '0.2.16', '0.2.28']) {
  test(`render migrated Server ${version} projections in Web: old message, Chat and answer`, async ({ page }) => {
    const original = JSON.parse(readFileSync(join(inventory!, '0.1.49.json'), 'utf8'));
    const { items, projections } = JSON.parse(readFileSync(join(inventory!, `${version}.json`), 'utf8'));
    const messagesAndHistory = (rows: { message: object; facts: object[] }[]) =>
      rows.map(({ message, facts }) => ({ message, facts }));
    expect(messagesAndHistory(items)).toEqual(messagesAndHistory(original.items));
    expect(original.items.find((item: { message_id: string }) => item.message_id === 'answered').terminal)
      .toContain('Synthetic answer');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route(/\/v2\//, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/v2/inbox') return route.fulfill({ json: projections.inbox });
      const match = pathname.match(/^\/v2\/items\/([^/]+)\/entries$/);
      const records: { id: string; entries: string }[] = Object.values(projections.direct_item_reads);
      const record = match && records.find((entry) => entry.id === match[1]);
      if (record) return route.fulfill({ json: decode(record.entries) });
      if (pathname === '/v2/me') return route.fulfill({ json: { features: {} } });
      return route.fulfill({ status: 400, json: {} });
    });
    const row = (kind: string) => page.getByTestId('row').filter({ hasText: `Synthetic ${kind}` });
    await page.goto('/inbox');
    await expect(row('unanswered')).toBeVisible();
    await row('unanswered').click();
    await expect(page.getByRole('heading', { name: 'Synthetic unanswered' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy message ID' })).toContainText('i1');
    await expect(row('discussed')).toBeVisible();
    await row('discussed').click();
    await expect(page.getByRole('heading', { name: 'Synthetic discussed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy message ID' })).toContainText('i3');
    await expect(page.locator('.chat-col').getByText('Synthetic discussion')).toBeVisible();
    await page.getByRole('tab', { name: 'Replied' }).click();
    await row('answered').click();
    await expect(page.getByRole('heading', { name: 'Synthetic answered' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy message ID' })).toContainText('i2');
    await expect(page.getByText('Synthetic answer', { exact: true })).toBeVisible();
  });
}
