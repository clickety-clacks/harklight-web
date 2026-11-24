import { expect, test, type Page } from '@playwright/test';

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

const SEEN_ACTION = { schema: 'attention-client.actions/1', actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: 'seen' }] };
const progressAt = (percent: number) => ({ percent, stage: 'Build', updated_at: '2026-11-24T12:00:00Z', segments: [{ stage: 'Build', width: percent }] });
const fake = (page: Page, what: string, data: unknown = {}) => page.request.post(`/__fake/${what}`, { data });
const sendProgress = (page: Page, message_id: string, title: string, percent: number, answer_ui: unknown = SEEN_ACTION) =>
  fake(page, 'send', { chat: true, message: { sender_id: 'agent:build', message_id, title, message_type: 'fyi', progress: progressAt(percent), ...(answer_ui ? { answer_ui } : {}) } });
/** The Seen writes sent, as "<message id> <seen|answer>". */
function seenWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (r) => {
    const m = r.method() === 'POST' && new URL(r.url()).pathname.match(/items\/it_([^/]+)\/(answer|seen)$/);
    if (m) writes.push(`${Buffer.from(m[1], 'base64url').toString().split('\u0000')[1]} ${m[2]}`);
  });
  return writes;
}
const article = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title });
async function openFyis(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /Open FYIs/ }).click();
}

test('Seen and Mark All Seen leave unfinished Progress open, so the agent can keep updating it', async ({ page }) => {
  await fake(page, 'reset');
  await sendProgress(page, 'p-one', 'Progress one', 30);
  await sendProgress(page, 'p-two', 'Progress two', 60);
  await sendProgress(page, 'p-done', 'Progress done', 100);
  const writes = seenWrites(page);
  await openFyis(page);
  await page.getByRole('button', { name: 'Mark seen: Progress one' }).click();
  await expect(article(page, 'Progress one').getByText('Seen', { exact: true })).toBeVisible();
  expect(writes).toEqual(['p-one seen']);
  await page.getByRole('button', { name: 'Mark All Seen' }).click();
  await expect(page.getByRole('button', { name: 'Mark All Seen' })).toBeDisabled();
  await expect(page.locator('.fyi-unseen')).toHaveText('0 unseen');
  expect(writes.filter((w) => w.startsWith('p-')).sort()).toEqual(['p-done answer', 'p-one seen', 'p-two seen']);
  // The agent can still update the unfinished ones, and only those.
  expect((await fake(page, 'revise', { title: 'Progress one', message: { progress: progressAt(40) } })).status()).toBe(200);
  expect((await fake(page, 'revise', { title: 'Progress done', message: { progress: progressAt(100) } })).status()).toBe(409);
});

test('Seen on the message itself leaves unfinished Progress open', async ({ page }) => {
  await fake(page, 'reset');
  await sendProgress(page, 'p-one', 'Progress one', 30);
  const writes = seenWrites(page);
  await openFyis(page);
  await article(page, 'Progress one').getByRole('button', { name: 'Open conversation' }).click();
  expect(writes).toEqual([]);
  await page.locator('button.seen-under').click();
  await expect(page.getByTestId('seen-done')).toBeVisible();
  await expect(page.locator('button.seen-under')).toHaveCount(0);
  expect(writes).toEqual(['p-one seen']);
});

test('a Seen that failed while Progress was unfinished is sent as the answer once it has finished', async ({ page }) => {
  await fake(page, 'reset');
  await sendProgress(page, 'p-one', 'Progress one', 30);
  const writes = seenWrites(page);
  await page.route(/\/seen$/, (route) => route.fulfill({ status: 400, json: { error: 'invalid_field', retryable: false } }));
  await openFyis(page);
  await page.getByRole('button', { name: 'Mark seen: Progress one' }).click();
  await expect(article(page, 'Progress one').getByText('Retry Seen')).toBeVisible();
  await fake(page, 'revise', { title: 'Progress one', message: { progress: progressAt(100), body: 'Finished now' } });
  await expect(article(page, 'Progress one')).toContainText('Finished now');
  await page.getByRole('button', { name: 'Mark seen: Progress one' }).click();
  await expect(article(page, 'Progress one').getByText('Seen', { exact: true })).toBeVisible();
  expect(writes).toEqual(['p-one seen', 'p-one answer']);
});

test('Progress that is closed, or offers no Seen, reads as any other message', async ({ page }) => {
  await fake(page, 'reset');
  await sendProgress(page, 'p-ans', 'Answered elsewhere', 30);
  await sendProgress(page, 'p-ret', 'Retracted later', 30);
  await sendProgress(page, 'p-plain', 'No Seen action', 30, null);
  await openFyis(page);
  await page.getByRole('button', { name: 'Mark All Seen' }).click();
  await expect(page.locator('.fyi-unseen')).toHaveText('0 unseen');
  await fake(page, 'answer-elsewhere', { title: 'Answered elsewhere', text: 'From the phone' });
  await fake(page, 'retract', { title: 'Retracted later' });
  await expect(article(page, 'Retracted later')).toContainText('The sender retracted this message.');
  await page.reload();
  const open = async (t: string) => {
    await page.goto('/inbox#preview');
    await page.getByRole('button', { name: /Open FYIs/ }).click();
    await article(page, t).getByRole('button', { name: 'Open conversation' }).click();
  };
  await open('Answered elsewhere');
  await expect(page.getByTestId('answered')).toContainText('From the phone');
  await expect(page.getByTestId('seen-done')).toHaveCount(0);
  await open('Retracted later');
  await expect(page.getByText('The sender retracted this message.')).toBeVisible();
  await expect(page.getByTestId('seen-done')).toHaveCount(0);
  await open('No Seen action');
  await expect(page.getByRole('radio', { name: 'Reply' }).or(page.getByRole('textbox', { name: 'Reply' })).first()).toBeVisible();
  await expect(page.getByTestId('seen-done')).toHaveCount(0);
});
