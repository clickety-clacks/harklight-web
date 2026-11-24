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
      item.created_at_ms = item.message.created_at;
      if (item.message.title === 'The hosting card expires next month') {
        delete item.message.message_type; // Legacy Seen-descriptor FYI.
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
  await expect(page.getByRole('heading', { name: 'FYIs', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: /show actions/i })).toHaveCount(0);
  const headings = page.getByRole('heading', { level: 2 });
  await expect(headings.first()).toHaveText('The hosting card expires next month');
  await expect(page.getByText('Renewals after December 1 will fail unless the card is replaced.')).toBeVisible();
  await page.getByRole('button', { name: 'Sort: Priority' }).press('Space');
  await expect(headings.first()).toHaveText('Your week ahead');
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  const seenButton = page.getByRole('button', { name: 'Mark seen: Quarterly report is ready' });
  await expect(seenButton).toBeVisible();
  const titleBox = await headings.filter({ hasText: 'Quarterly report is ready' }).boundingBox();
  const seenBox = await seenButton.boundingBox();
  expect(seenBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
  await seenButton.press('Enter');
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

test('opening a FYI conversation reads its existing history without marking Seen', async ({ page }) => {
  await page.request.post('/__fake/reset');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route(/\/v2\/inbox(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const item = json.items.find((candidate: { message: { title: string } }) =>
      candidate.message.title === 'Which hotel should I book for Lisbon?');
    item.message.message_type = 'fyi';
    item.chat.unread_replies = 0;
    await route.fulfill({ response, json });
  });
  const operations: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(entries|answer|seen)$/.test(path)) operations.push(`${request.method()} ${path}`);
  });

  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: 'Open FYIs, 3 unseen' }).press('Enter');
  await page.getByRole('article').filter({ hasText: 'Which hotel should I book for Lisbon?' })
    .getByRole('button', { name: 'Open conversation' }).press('Enter');
  await expect(page.getByRole('dialog').getByText('I can hold either room until 6 PM today.')).toBeVisible();
  expect(operations.some((entry) => /^GET .*\/entries$/.test(entry))).toBe(true);
  expect(operations.filter((entry) => entry.startsWith('POST '))).toEqual([]);
});

test('desktop FYI keeps the real Inbox and Replied tabs with the approved row treatments', async ({ page }) => {
  await page.request.post('/__fake/reset');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/__fake/standard-order');
  await page.goto('/inbox#preview');
  const digest = page.getByRole('button', { name: 'Open FYIs, 2 unseen' });
  await expect(digest.locator('.fyi-digest-agent')).toBeVisible();
  await expect(digest.locator('.fyi-digest-heading')).toHaveCSS('font-family', /Georgia/);

  const request = page.getByTestId('row').filter({ hasText: 'Approve the survey questions?' });
  await expect(request.locator('.row-title .t')).toHaveCSS('font-weight', '650');
  await expect(request.locator('.row-title .t')).toHaveCSS('font-size', '18px');
  await expect(request.locator('.row-tile--request')).toBeVisible();

  await digest.press('Enter');
  await expect(page.getByRole('tab', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.locator('.main-col').getByRole('heading', { name: 'FYIs', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Back to Inbox' }).press('Enter');
  await expect(digest).toBeFocused();

  await request.click();
  await page.getByRole('radio', { name: 'Approve' }).check();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toBeVisible();
  await page.getByRole('tab', { name: 'Replied', exact: true }).click();
  await expect(digest).toHaveCount(0);
  await expect(request.locator('.row-tile--check')).toBeVisible();
  await page.getByRole('tab', { name: 'Inbox', exact: true }).click();
  await expect(digest).toBeVisible();
  await expect(request).toHaveCount(0);
});

test('Back pressed as the FYI list opens returns focus to the summary', async ({ page }) => {
  await page.request.post('/__fake/reset');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  await expect(page.getByRole('button', { name: /Open FYIs/ })).toBeVisible();
  // In the page, so nothing is painted between the two presses.
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('.fyi-summary')!.click();
    while (!document.querySelector('.fyi-back')) await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLElement>('.fyi-back')!.click();
  });
  await expect(page.getByRole('button', { name: /Open FYIs/ })).toBeFocused();
});

test('Seen and Mark All Seen leave unfinished Progress open, so the agent can keep updating it', async ({ page }) => {
  await page.request.post('/__fake/reset');
  const answer_ui = { schema: 'attention-client.actions/1', actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: 'seen' }] };
  const at = '2026-11-24T12:00:00Z';
  const progress = (percent: number) => ({ percent, stage: 'Build', updated_at: at, segments: [{ stage: 'Build', width: percent }] });
  const send = (message_id: string, title: string, percent: number) =>
    page.request.post('/__fake/send', { data: { chat: true, message: { sender_id: 'agent:build', message_id, title, message_type: 'fyi', answer_ui, progress: progress(percent) } } });
  await send('p-one', 'Progress one', 30);
  await send('p-two', 'Progress two', 60);
  await send('p-done', 'Progress done', 100);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    const m = new URL(r.url()).pathname.match(/items\/it_([^/]+)\/(answer|seen)$/);
    if (m) writes.push(`${Buffer.from(m[1], 'base64url').toString().split('\u0000')[1]} ${m[2]}`);
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await page.getByRole('button', { name: 'Mark seen: Progress one' }).click();
  const one = page.getByRole('article').filter({ hasText: 'Progress one' });
  await expect(one.getByText('Seen', { exact: true })).toBeVisible();
  expect(writes).toEqual(['p-one seen']);
  await page.getByRole('button', { name: 'Mark All Seen' }).click();
  await expect(page.getByRole('button', { name: 'Mark All Seen' })).toBeDisabled();
  await expect(page.locator('.fyi-unseen')).toHaveText('0 unseen');
  expect(writes.filter((w) => w.startsWith('p-')).sort()).toEqual(['p-done answer', 'p-one seen', 'p-two seen']);
  // On the message itself: already Seen, and no button that would end it.
  await one.getByRole('button', { name: 'Open conversation' }).click();
  await expect(page.getByTestId('seen-done')).toBeVisible();
  await expect(page.locator('button.seen-under')).toHaveCount(0);
});

test('Seen on the message itself leaves unfinished Progress open', async ({ page }) => {
  await page.request.post('/__fake/reset');
  const answer_ui = { schema: 'attention-client.actions/1', actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: 'seen' }] };
  await page.request.post('/__fake/send', {
    data: { chat: true, message: { sender_id: 'agent:build', message_id: 'p-one', title: 'Progress one', message_type: 'fyi', answer_ui, progress: { percent: 30 } } },
  });
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/(answer|seen)$/.test(r.url())) writes.push(r.url().split('/').at(-1)!);
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await page.getByRole('article').filter({ hasText: 'Progress one' }).getByRole('button', { name: 'Open conversation' }).click();
  expect(writes).toEqual([]);
  await page.locator('button.seen-under').click();
  await expect(page.getByTestId('seen-done')).toBeVisible();
  expect(writes).toEqual(['seen']);
});
