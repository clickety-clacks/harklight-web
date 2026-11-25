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
    }
    await route.fulfill({ response, json });
  });
  await page.goto('/inbox#preview');
  const summary = page.getByRole('button', { name: 'Open FYIs, 2 unseen' });
  await expect(summary).toContainText('All twelve sections are written');
  await expect(summary).not.toContainText('Nine meetings');
  await expect(page.getByTestId('row').filter({ hasText: 'Quarterly report is ready' })).toHaveCount(0);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'FYIs', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Open conversation' })).toHaveCount(0);
  const rows = page.locator('.fyi-open');
  await expect(rows.first()).toHaveAccessibleName('The hosting card expires next month');
  await expect(page.getByText('Renewals after December 1 will fail unless the card is replaced.')).toBeVisible();
  await page.getByRole('navigation', { name: 'FYI list controls' }).getByRole('button', { name: 'Sort: Priority' }).press('Space');
  await expect(rows.first()).toHaveAccessibleName('Quarterly report is ready');
  await expect(rows).toHaveCount(2);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  const seenButton = page.getByRole('button', { name: 'Mark seen: Quarterly report is ready' });
  await expect(seenButton).toBeVisible();
  const titleBox = await page.getByRole('button', { name: 'Quarterly report is ready', exact: true }).boundingBox();
  const seenBox = await seenButton.boundingBox();
  expect(seenBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
  await seenButton.press('Enter');
  await expect(rows).toHaveCount(1);
  // Focus goes to the one that took its place, not to the top of the page.
  await expect(page.getByRole('button', { name: 'Mark seen: The hosting card expires next month' })).toBeFocused();
  await page.getByRole('button', { name: 'Back to Inbox' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Open FYIs, 1 unseen' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Mark All Seen' }).press('Enter');
  await expect(page.getByText('All FYIs are seen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark All Seen' })).toBeDisabled();
  await expect(rows).toHaveCount(0);
  expect(writes.map((url) => new URL(url).pathname.split('/').at(-1))).toEqual(['answer', 'answer']);
  await page.getByRole('button', { name: 'Back to Inbox' }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Inbox' })).toBeFocused();
  await expect(page.locator('.fyi-summary')).toHaveCount(0);
  // All three are in Replied's own list, with nothing left to mark.
  await page.getByRole('tab', { name: 'Replied' }).click();
  await page.getByRole('button', { name: 'Open seen FYIs' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Seen FYIs', exact: true })).toBeFocused();
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole('button', { name: /^Mark/ })).toHaveCount(0);
  await expect(page.getByText(/unseen/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Replied' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Open seen FYIs' })).toBeFocused();
});

test('opening a FYI shows detail and reads its history without marking Seen', async ({ page }) => {
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
    .getByRole('button', { name: 'Which hotel should I book for Lisbon?', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Which hotel should I book for Lisbon?' })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /^Chat/ }).press('Enter');
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
  await expect(digest.locator('.fyi-digest-heading')).toHaveCSS('font-family', /system-ui/);

  const request = page.getByTestId('row').filter({ hasText: 'Approve the survey questions?' });
  await expect(request.locator('.row-title .t')).toHaveCSS('font-weight', '650');
  await expect(request.locator('.row-title .t')).toHaveCSS('font-size', '17px');
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
  await expect(page.getByRole('button', { name: 'Open seen FYIs' })).toContainText('Your week ahead');
  await expect(page.getByTestId('row').filter({ hasText: 'Your week ahead' })).toHaveCount(0);
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
  await expect(article(page, 'Progress one')).toHaveCount(0);
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
  await article(page, 'Progress one').getByRole('button', { name: 'Progress one', exact: true }).click();
  expect(writes).toEqual([]);
  await page.locator('button.seen-under').click();
  await expect(page.getByTestId('seen-done')).toBeVisible();
  await expect(page.locator('button.seen-under')).toHaveCount(0);
  expect(writes).toEqual(['p-one seen']);
});

test('finished Progress that is already marked Seen offers nothing on its own page', async ({ page }) => {
  await fake(page, 'reset');
  await sendProgress(page, 'p-done', 'Progress done', 100);
  const id = `it_${Buffer.from('agent:build\u0000p-done').toString('base64url')}`;
  await page.goto('/inbox#preview');
  await page.request.post(`/v2/items/${id}/seen`, { data: {}, headers: { 'idempotency-key': crypto.randomUUID(), origin: new URL(page.url()).origin } });
  const writes = seenWrites(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByRole('tab', { name: 'Replied', exact: true }).click();
  await page.getByRole('button', { name: 'Open seen FYIs' }).click();
  await article(page, 'Progress done').getByRole('button', { name: 'Progress done', exact: true }).click();
  await expect(page.getByTestId('seen-done')).toBeVisible();
  await expect(page.locator('button.seen-under')).toHaveCount(0);
  expect(writes).toEqual([]);
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
  await expect(article(page, 'Progress one')).toHaveCount(0);
  expect(writes).toEqual(['p-one seen', 'p-one answer']);
});

test('a Seen whose response was lost is resent as it was, never as an answer, after Progress finishes', async ({ page }) => {
  await fake(page, 'reset');
  await sendProgress(page, 'p-one', 'Progress one', 30);
  const writes = seenWrites(page);
  const keys: (string | undefined)[] = [];
  await page.route(/\/seen$/, async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length > 1) return route.fallback();
    // The Server takes it, the agent finishes, and the response never arrives.
    await route.fetch();
    await fake(page, 'revise', { title: 'Progress one', message: { progress: progressAt(100), body: 'Finished now' } });
    await route.abort('connectionreset');
  });
  await openFyis(page);
  await page.getByRole('button', { name: 'Mark seen: Progress one' }).click();
  await expect.poll(() => keys.length, { timeout: 15000 }).toBe(2);
  await expect(article(page, 'Progress one')).toContainText('Finished now');
  expect(writes).toEqual(['p-one seen', 'p-one seen']);
  expect(keys[1]).toBe(keys[0]);
  // Still open: the agent can revise it again.
  expect((await fake(page, 'revise', { title: 'Progress one', message: { body: 'One more thing' } })).status()).toBe(200);
});

test('Progress that is closed, or offers no Seen, reads as any other message', async ({ page }) => {
  await fake(page, 'reset');
  await sendProgress(page, 'p-ans', 'Answered elsewhere', 30);
  await sendProgress(page, 'p-ret', 'Retracted later', 30);
  await sendProgress(page, 'p-plain', 'No Seen action', 30, null);
  await openFyis(page);
  await page.getByRole('button', { name: 'Mark All Seen' }).click();
  await expect(page.getByText('All FYIs are seen')).toBeVisible();
  await fake(page, 'answer-elsewhere', { title: 'Answered elsewhere', text: 'From the phone' });
  await fake(page, 'retract', { title: 'Retracted later' });
  await page.goto('/inbox#preview');
  const row = (t: string) => page.getByTestId('row').filter({ hasText: t });
  await row('Retracted later').click();
  await expect(page.getByText('The sender retracted this message.')).toBeVisible();
  await expect(page.getByTestId('seen-done')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Replied', exact: true }).click();
  await row('Answered elsewhere').click();
  await expect(page.getByTestId('answered')).toContainText('From the phone');
  await expect(page.getByTestId('seen-done')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open seen FYIs' }).click();
  await expect(article(page, 'Answered elsewhere')).toHaveCount(0);
  await expect(article(page, 'Retracted later')).toHaveCount(0);
  await article(page, 'No Seen action').getByRole('button', { name: 'No Seen action', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Reply' }).or(page.getByRole('textbox', { name: 'Reply' })).first()).toBeVisible();
  await expect(page.getByTestId('seen-done')).toHaveCount(0);
});

const tabTo = (page: Page, name: 'Inbox' | 'Replied') => page.getByRole('tab', { name, exact: true }).click();
const sendFyi = (page: Page, message_id: string, title: string, answer_ui: unknown = SEEN_ACTION) =>
  fake(page, 'send', { chat: true, message: { sender_id: 'agent:build', message_id, title, message_type: 'fyi', ...(answer_ui ? { answer_ui } : {}) } });

test('a FYI stays in Inbox until Seen is confirmed, then moves to Replied', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'hold-answers');
  await openFyis(page);
  const report = article(page, 'Quarterly report is ready');
  await report.getByRole('button', { name: /Mark seen/ }).click();
  await expect(report.getByText('Marking…')).toBeVisible();
  await expect(page.locator('.fyi-unseen')).toHaveText('2 unseen');
  await fake(page, 'release-answers');
  await expect(report).toHaveCount(0);
  await expect(page.locator('.fyi-unseen')).toHaveText('1 unseen');
  await expect(page.getByRole('button', { name: 'Open FYIs, 1 unseen' })).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(report).toBeVisible();
  await expect(article(page, 'The hosting card expires next month')).toHaveCount(0);
});

test('opening a FYI that offers Seen does not take it out of Inbox', async ({ page }) => {
  await fake(page, 'reset');
  await page.goto('/inbox#preview');
  await expect(page.getByRole('button', { name: 'Open FYIs, 2 unseen' })).toBeVisible();
  // Another client reports that the person opened it.
  const id = `it_${Buffer.from('agent:build\u0000quarterly').toString('base64url')}`;
  const res = await page.request.post(`/v2/items/${id}/seen`, { data: {}, headers: { 'idempotency-key': crypto.randomUUID(), origin: new URL(page.url()).origin } });
  expect(res.status()).toBe(200);
  const item = await (await page.request.get(`/v2/items/${id}`)).json();
  expect((item.item ?? item).seen).toBe(true);
  const writes = seenWrites(page);
  await openFyis(page);
  await article(page, 'Quarterly report is ready').getByRole('button', { name: /Mark seen/ }).click();
  await expect(article(page, 'Quarterly report is ready')).toHaveCount(0);
  expect(writes).toEqual(['quarterly answer']);
});

test('FYIs that ended or were answered without Seen stay reachable and uncounted', async ({ page }) => {
  await fake(page, 'reset');
  await sendFyi(page, 'f-ret', 'Retracted notice');
  await sendFyi(page, 'f-ans', 'Answered notice');
  await fake(page, 'retract', { title: 'Retracted notice' });
  await fake(page, 'answer-elsewhere', { title: 'Answered notice', text: 'From the phone' });
  await openFyis(page);
  await expect(page.locator('.fyi-unseen')).toHaveText('2 unseen');
  const ended = article(page, 'Retracted notice');
  await expect(ended).toHaveCount(0);
  await expect(article(page, 'Answered notice')).toHaveCount(0);
  const endedRow = page.getByTestId('row').filter({ hasText: 'Retracted notice' });
  await expect(endedRow).toContainText(/Retracted/i);
  await endedRow.click();
  await expect(page.getByText('The sender retracted this message.')).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(page.getByTestId('row').filter({ hasText: 'Answered notice' })).toBeVisible();
  await expect(page.getByTestId('row').filter({ hasText: 'Retracted notice' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open seen FYIs' }).click();
  await expect(article(page, 'Answered notice')).toHaveCount(0);
  await expect(ended).toHaveCount(0);
});

test('the open FYI list follows the tab, and Back restores the tab with the pane', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'answer-elsewhere', { title: 'Approve the survey questions?', text: 'Approved' });
  await openFyis(page);
  const pane = page.locator('.main-col');
  await expect(pane.getByRole('heading', { name: 'FYIs', exact: true })).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(pane.getByRole('heading', { name: 'Seen FYIs', exact: true })).toBeVisible();
  await expect(article(page, 'Your week ahead')).toBeVisible();
  await expect(article(page, 'Quarterly report is ready')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Replied' })).toBeFocused();
  await tabTo(page, 'Inbox');
  await expect(pane.getByRole('heading', { name: 'FYIs', exact: true })).toBeVisible();
  await expect(article(page, 'Your week ahead')).toHaveCount(0);
  // A message opened on Inbox, then the list on Replied, then Back: Inbox again, with its message.
  await page.getByTestId('row').filter({ hasText: 'Production deploy failed' }).click();
  await expect(pane.getByText('Production deploy failed').first()).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(pane.getByRole('heading', { name: 'Seen FYIs', exact: true })).toBeVisible();
  await page.getByTestId('row').first().click();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Replied' })).toHaveAttribute('aria-selected', 'true');
  await expect(pane.getByRole('heading', { name: 'Seen FYIs', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
  await expect(pane.getByRole('heading', { name: 'FYIs', exact: true })).toBeVisible();
});

test('a message open beside the list gives way to what was last open on the other tab', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'standard-order');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  const pane = page.locator('.main-col');
  const empty = pane.getByText('Select a message');
  const title = (t: string) => pane.getByRole('heading', { name: t }).first();
  await page.getByTestId('row').filter({ hasText: 'Production deploy failed' }).click();
  await expect(title('Production deploy failed')).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(empty).toBeVisible();
  await tabTo(page, 'Inbox');
  await expect(title('Production deploy failed')).toBeVisible();
  // Answered, it is no longer on Inbox: coming back shows the empty state, and Replied has it.
  await page.getByRole('radio', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Roll it back');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(empty).toBeVisible();
  await tabTo(page, 'Inbox');
  await expect(empty).toBeVisible();
  await tabTo(page, 'Replied');
  await page.getByTestId('row').filter({ hasText: 'Production deploy failed' }).click();
  await tabTo(page, 'Inbox');
  await expect(empty).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(title('Production deploy failed')).toBeVisible();
});

test('at phone width each tab has its own FYI card and list', async ({ page }) => {
  await fake(page, 'reset');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/inbox#preview');
  await tabTo(page, 'Replied');
  await page.getByRole('button', { name: 'Open seen FYIs' }).click();
  await expect(article(page, 'Your week ahead')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Replied' })).toHaveAttribute('aria-selected', 'true');
  await tabTo(page, 'Inbox');
  await page.getByRole('button', { name: 'Open FYIs, 2 unseen' }).click();
  await expect(article(page, 'Your week ahead')).toHaveCount(0);
});

test('an answered message the Inbox still lists under History is still shown on return', async ({ page }) => {
  await fake(page, 'reset');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  const pane = page.locator('.main-col');
  await page.getByTestId('row').filter({ hasText: 'Production deploy failed' }).click();
  await fake(page, 'answer-elsewhere', { title: 'Production deploy failed', text: 'Rolled back' });
  await expect(page.getByTestId('answered')).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(pane.getByText('Select a message')).toBeVisible();
  await tabTo(page, 'Inbox');
  await expect(pane.getByRole('heading', { name: 'Production deploy failed' }).first()).toBeVisible();
  await expect(page.getByTestId('row').filter({ hasText: 'Production deploy failed' })).toBeVisible();
});

test('Back to the list never leaves Harklight, however the FYI list was reached', async ({ page }) => {
  await fake(page, 'reset');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/__fake/state');
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await tabTo(page, 'Replied');
  await page.getByRole('button', { name: 'Back to Replied' }).click();
  await tabTo(page, 'Inbox');
  await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await expect(page.getByRole('tab', { name: 'Inbox' })).toBeVisible();
  await expect(page.locator('.fyi-list')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/inbox');
  // From a message on Inbox to Replied's remembered list: its button goes to Replied.
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await tabTo(page, 'Replied');
  await tabTo(page, 'Inbox');
  await page.getByTestId('row').filter({ hasText: 'Production deploy failed' }).click();
  await tabTo(page, 'Replied');
  await page.getByRole('button', { name: 'Back to Replied' }).click();
  await expect(page.getByRole('tab', { name: 'Replied' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.main-col').getByText('Select a message')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open seen FYIs' })).toBeFocused();
  // Browser Back still walks the steps, each with its own tab and pane.
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.main-col').getByRole('heading', { name: 'FYIs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await expect(page.locator('.fyi-list')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
  // Forward to a list whose earlier step has changed tab: its button still stays on its tab.
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await page.goBack();
  await tabTo(page, 'Replied');
  await page.goForward();
  await expect(page.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await expect(page.locator('.fyi-list')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
  // A reload shows no list, and one opened after it closes the same way.
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await page.reload();
  await expect(page.locator('.fyi-list')).toHaveCount(0);
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await expect(page.getByRole('button', { name: /Open FYIs/ })).toBeVisible();
});

test('Forward does not bring back a message that has left the tab', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'standard-order');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  const row = page.getByTestId('row').filter({ hasText: 'Production deploy failed' });
  await row.click();
  await expect(page.locator('.main-col').getByRole('heading', { name: 'Production deploy failed' }).first()).toBeVisible();
  await page.goBack();
  await fake(page, 'answer-elsewhere', { title: 'Production deploy failed', text: 'Rolled back' });
  await expect(row).toHaveCount(0);
  await page.goForward();
  await expect(page.getByText('Select a message')).toBeVisible();
  await expect(page.locator('.chat-col')).toHaveCount(0);
});

test('a step taken before the messages load does not bring back one that has left the tab', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'standard-order');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  await page.getByTestId('row').filter({ hasText: 'Production deploy failed' }).click();
  await page.goBack();
  await fake(page, 'answer-elsewhere', { title: 'Production deploy failed', text: 'Rolled back' });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/v2\/inbox(?:\?|$)/, async (route) => {
    await held;
    await route.fallback();
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Inbox' })).toBeVisible();
  await page.goForward();
  release();
  await expect(page.getByTestId('row').first()).toBeVisible();
  await expect(page.getByText('Select a message')).toBeVisible();
  await expect(page.locator('.chat-col')).toHaveCount(0);
});

test('a FYI answered some other way is one Replied row, under History or not', async ({ page }) => {
  await fake(page, 'reset');
  await sendFyi(page, 'f-ans', 'Answered notice');
  await sendFyi(page, 'f-flag', 'Flagged notice', null);
  await openFyis(page);
  await article(page, 'Flagged notice').getByRole('button', { name: /Mark seen/ }).click();
  await expect(article(page, 'Flagged notice')).toHaveCount(0);
  for (const t of ['Answered notice', 'Flagged notice']) await fake(page, 'answer-elsewhere', { title: t, text: 'In writing' });
  const row = (t: string) => page.getByTestId('row').filter({ hasText: t });
  for (const order of ['free', 'standard']) {
    if (order === 'standard') await fake(page, 'standard-order');
    await page.goto('/inbox#preview');
    await expect(page.getByRole('button', { name: /Open FYIs/ })).toBeVisible();
    for (const t of ['Answered notice', 'Flagged notice']) await expect(row(t), `${order} inbox`).toHaveCount(0);
    await tabTo(page, 'Replied');
    for (const t of ['Answered notice', 'Flagged notice']) await expect(row(t), `${order} replied`).toHaveCount(1);
  }
});

test('a Seen FYI whose chat reply is still in Inbox comes back with the tab', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'standard-order');
  await sendFyi(page, 'f-flag', 'Flagged notice', null);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.route(/\/read-position$/, () => {}); // The reply stays unread.
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await article(page, 'Flagged notice').getByRole('button', { name: /Mark seen/ }).click();
  await expect(article(page, 'Flagged notice')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await fake(page, 'reply', { sender_id: 'agent:build', message_id: 'f-flag', text: 'One more thing' });
  await page.getByTestId('reply-row').filter({ hasText: 'Flagged notice' }).click();
  await page.keyboard.press('Escape');
  const title = page.locator('.main-col').getByRole('heading', { name: 'Flagged notice' }).first();
  await expect(title).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(title).toHaveCount(0);
  await tabTo(page, 'Inbox');
  await expect(title).toBeVisible();
});

test('Mark All Seen skips a FYI that is retracted while it runs', async ({ page }) => {
  await fake(page, 'reset');
  await sendFyi(page, 'f-a', 'First notice');
  await sendFyi(page, 'f-b', 'Second notice', null);
  await fake(page, 'hold-answers');
  const writes = seenWrites(page);
  await openFyis(page);
  await page.getByRole('navigation', { name: 'FYI list controls' }).getByRole('button', { name: 'Sort: Priority' }).click(); // newest first
  await page.getByRole('button', { name: 'Mark All Seen' }).click();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  const pending = ['First notice', 'Second notice', 'Quarterly report is ready', 'The hosting card expires next month'];
  const later = pending.filter((t) => !writes.some((w) => w.startsWith({ 'First notice': 'f-a', 'Second notice': 'f-b', 'Quarterly report is ready': 'quarterly', 'The hosting card expires next month': 'card-expiry' }[t]!)));
  expect(later.length).toBeGreaterThan(0);
  for (const t of later) await fake(page, 'retract', { title: t });
  for (const t of later) await expect(article(page, t)).toHaveCount(0);
  const before = writes.length;
  await fake(page, 'release-answers');
  await expect(page.getByText('All FYIs are seen')).toBeVisible();
  await page.waitForTimeout(400);
  expect(writes.length).toBe(before);
});

for (const width of [390, 1280]) {
  test(`FYI detail Back restores the sort, scroll and row focus at ${width}px`, async ({ page }) => {
    await fake(page, 'reset');
    for (let i = 0; i < 16; i++) await sendFyi(page, `scroll-${i}`, `FYI notice ${i}`);
    await page.setViewportSize({ width, height: 650 });
    await page.goto('/inbox#preview');
    await page.getByRole('button', { name: /Open FYIs/ }).click();
    await page.getByRole('navigation', { name: 'FYI list controls' }).getByRole('button', { name: 'Sort: Priority' }).click();
    const list = page.getByRole('main', { name: 'FYIs', exact: true });
    const row = list.locator('.fyi-open').last();
    await row.scrollIntoViewIfNeeded();
    const scroll = await list.evaluate((node) => node.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    const name = await row.getAttribute('aria-label');
    const detail = page.getByRole('heading', { name: name!, exact: true });
    await row.click();
    await expect(detail).toBeFocused();
    await page.getByRole('button', { name: 'Back to FYIs' }).press('Enter');
    await expect(row).toBeFocused();
    await expect(page.getByRole('navigation', { name: 'FYI list controls' }).getByRole('button', { name: 'Sort: Posted' })).toBeVisible();
    expect(await list.evaluate((node) => node.scrollTop)).toBe(scroll);
    await page.goForward();
    await expect(detail).toBeFocused();
    await page.goBack();
    await expect(row).toBeFocused();
    expect(await list.evaluate((node) => node.scrollTop)).toBe(scroll);
  });
}

test('main Inbox and Replied remember independent orders and keep their details', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'standard-order');
  const titles = ['Older request', 'Newer request', 'Older answered', 'Newer answered'];
  for (const [index, title] of titles.entries()) {
    await fake(page, 'send', { message: { sender_id: 'agent:order', message_id: `sort-${index}`, title, message_type: 'request' } });
    if (index >= 2) expect((await fake(page, 'answer-elsewhere', { title, text: 'Done' })).ok()).toBe(true);
  }
  await page.route(/\/v2\/inbox(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const item of json.items) {
      const index = titles.indexOf(item.message.title);
      if (index < 0) continue;
      item.rank.key = `000${index}`;
      item.created_at_ms = 1000 * (index + 1);
    }
    await route.fulfill({ response, json });
  });
  const writes = seenWrites(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  const sidebar = page.getByRole('complementary', { name: 'Inbox' });
  const sort = sidebar.getByRole('button', { name: /^Sort:/ });
  const rows = sidebar.getByTestId('row').filter({ hasText: /(?:Older|Newer) (?:request|answered)/ });
  const titlesInOrder = (first: string, second: string) =>
    expect(rows.locator('.row-title .t')).toHaveText([first, second]);
  const detail = (title: string) => page.locator('.detail').getByRole('heading', { name: title, exact: true });

  await titlesInOrder('Older request', 'Newer request');
  await sort.press('Space');
  await expect(sort).toHaveAccessibleName('Sort: Posted');
  await titlesInOrder('Newer request', 'Older request');
  await rows.filter({ hasText: 'Newer request' }).click();
  await expect(detail('Newer request')).toBeVisible();
  await sort.click();
  await expect(sort).toHaveAccessibleName('Sort: Priority');
  await expect(detail('Newer request')).toBeVisible();
  await rows.filter({ hasText: 'Older request' }).click();
  await expect(detail('Older request')).toBeVisible();
  await expect.poll(() => writes).toEqual(['sort-1 seen', 'sort-0 seen']);
  await sort.click();

  await tabTo(page, 'Replied');
  await expect(sort).toHaveAccessibleName('Sort: Priority');
  await titlesInOrder('Older answered', 'Newer answered');
  await sort.click();
  await titlesInOrder('Newer answered', 'Older answered');
  await rows.filter({ hasText: 'Older answered' }).click();
  await expect(detail('Older answered')).toBeVisible();

  await tabTo(page, 'Inbox');
  await expect(sort).toHaveAccessibleName('Sort: Posted');
  await expect(detail('Older request')).toBeVisible();
  await sort.click();
  await tabTo(page, 'Replied');
  await expect(sort).toHaveAccessibleName('Sort: Posted');
  await expect(detail('Older answered')).toBeVisible();
});

test('narrowing closes FYI Chat and Back restores the list across layouts', async ({ page }) => {
  await fake(page, 'reset');
  for (let i = 0; i < 16; i++) await sendFyi(page, `resize-${i}`, `FYI resize ${i}`);
  await page.setViewportSize({ width: 1280, height: 650 });
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  const toolbar = page.getByRole('navigation', { name: 'FYI list controls' });
  await toolbar.getByRole('button', { name: 'Sort: Priority' }).click();
  const list = page.getByRole('main', { name: 'FYIs', exact: true });
  const target = list.locator('.fyi-open').last();
  await target.scrollIntoViewIfNeeded();
  const scrollTop = await list.evaluate((node) => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  const title = await target.getAttribute('aria-label');
  const row = list.getByRole('button', { name: title!, exact: true });
  const detail = page.locator('.detail');
  const chat = detail.getByRole('button', { name: /^Chat/ });

  await row.click();
  await page.locator('.chat-col').getByRole('button', { name: 'Close chat' }).click();
  await chat.click();
  await expect(page.locator('.chat-col')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 650 });
  await expect(chat).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Back to FYIs' }).click();
  await expect(row).toBeFocused();
  await expect(toolbar.getByRole('button', { name: 'Sort: Posted' })).toBeVisible();
  expect(await list.evaluate((node) => node.scrollTop)).toBe(scrollTop);

  await row.click();
  await chat.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 650 });
  await expect(page.locator('.chat-col')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 650 });
  await expect(chat).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();
  await expect(row).toBeFocused();
});

test('review: a flag-only FYI stays unseen through Settings, reload and Forward', async ({ page }) => {
  await fake(page, 'reset');
  await sendFyi(page, 'flag-only', 'Flag-only FYI', null);
  const writes = seenWrites(page);
  await openFyis(page);
  const heading = page.locator('.detail').getByRole('heading', { name: 'Flag-only FYI', exact: true });
  await page.getByRole('button', { name: 'Flag-only FYI', exact: true }).click();
  await expect(heading).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(heading).toBeVisible();
  await expect(page.getByRole('button', { name: /Open FYIs, 3 unseen/ })).toBeVisible();
  expect(writes).toEqual([]);
  await page.reload();
  await expect(heading).toBeVisible();
  await page.getByRole('button', { name: 'Back to FYIs' }).click();
  await page.goForward();
  await expect(heading).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Back to FYIs' }).click();
  await page.getByRole('button', { name: 'Mark seen: Flag-only FYI' }).click();
  await expect.poll(() => writes).toEqual(['flag-only seen']);
});

test('review: switching away from FYI detail restores the other tab pane', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'answer-elsewhere', { title: 'Approve the survey questions?', text: 'Approved' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  const pane = page.locator('.main-col');
  const fyiTitle = 'Quarterly report is ready';
  const fyiDetail = pane.getByRole('heading', { name: fyiTitle, exact: true });
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  await page.getByRole('button', { name: fyiTitle, exact: true }).click();
  await tabTo(page, 'Replied');
  await expect(pane.getByText('Select a message')).toBeVisible();
  await page.getByTestId('row').filter({ hasText: 'Approve the survey questions?' }).click();
  const remembered = pane.getByRole('heading', { name: 'Approve the survey questions?', exact: true });
  await expect(remembered).toBeVisible();
  await tabTo(page, 'Inbox');
  await expect(fyiDetail).toBeVisible();
  await tabTo(page, 'Replied');
  await expect(remembered).toBeVisible();
  await page.getByRole('button', { name: 'Open seen FYIs' }).click();
  await expect(pane.getByRole('heading', { name: 'Seen FYIs', exact: true })).toBeVisible();
  await page.goBack();
  await expect(remembered).toBeVisible();
  // Open the list again and remember that pane when leaving the tab.
  await page.getByRole('button', { name: 'Open seen FYIs' }).click();
  await tabTo(page, 'Inbox');
  await expect(pane.getByRole('heading', { name: 'FYIs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: fyiTitle, exact: true }).click();
  await tabTo(page, 'Replied');
  await expect(pane.getByRole('heading', { name: 'Seen FYIs', exact: true })).toBeVisible();
});

test('review: Back from a Forward-revisited collapsed FYI Chat restores row focus', async ({ page }) => {
  await fake(page, 'reset');
  await sendFyi(page, 'forward-resize', 'Forward resize FYI', null);
  await page.setViewportSize({ width: 390, height: 650 });
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /Open FYIs/ }).click();
  const row = page.getByRole('button', { name: 'Forward resize FYI', exact: true });
  const detail = page.locator('.detail');
  const chat = detail.getByRole('button', { name: /^Chat/ });
  await row.click();
  await chat.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 650 });
  await expect(page.locator('.chat-col')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 650 });
  await expect(chat).toBeVisible();
  await page.goBack();
  await expect(row).toBeFocused();
  await page.goForward();
  await expect(detail).toBeVisible();
  await page.goForward();
  await expect(chat).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Back to FYIs' }).click();
  await expect(row).toBeFocused();
});

test('opening an expired flag-only FYI from an ordinary row files it under Seen FYIs', async ({ page }) => {
  await fake(page, 'reset');
  const title = 'Expired flag-only FYI';
  await sendFyi(page, 'expired-flag-only', title, null);
  expect((await fake(page, 'expire', { title })).ok()).toBe(true);
  const writes = seenWrites(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  const row = page.getByTestId('row').filter({ hasText: title });
  await expect(row).toContainText('Expired');
  await row.click();
  await expect(page.getByText('This message expired.')).toBeVisible();
  await expect.poll(() => writes).toEqual(['expired-flag-only seen']);
  await tabTo(page, 'Replied');
  await page.getByRole('button', { name: 'Open seen FYIs' }).click();
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test('Back after the first tab switch returns to Inbox', async ({ page }) => {
  await fake(page, 'reset');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox#preview');
  await page.getByTestId('row').filter({ hasText: 'Production deploy failed' }).click();
  await tabTo(page, 'Replied');
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Select a message')).toBeVisible();
});
