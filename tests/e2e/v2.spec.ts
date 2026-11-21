// What only client API v2 does, in the browser, with flags.clientApiV2 on.
// client.spec.ts runs the whole suite on both protocols; these cases are the
// ones the relay has no equivalent for. Runs in the chromium-v2 project.
import { expect, test, type Page } from '@playwright/test';

const control = (page: Page, what: string, body: unknown = {}) =>
  page.request.post(`/__fake/${what}`, { data: body }).then((r) => r.json());
const openRow = (page: Page, title: string) => page.getByTestId('row').filter({ hasText: title }).first().click();
const row = (page: Page, title: string) => page.getByTestId('row').filter({ hasText: title });

test.beforeEach(async ({ page }) => {
  await control(page, 'reset');
  await page.setViewportSize({ width: 1280, height: 800 });
});

async function openInbox(page: Page) {
  await page.goto('/inbox');
  await expect(page.getByTestId('row').first()).toBeVisible();
}

test('speaks only /v2: fetch reads and one EventSource, no WebSocket', async ({ page }) => {
  const sockets: string[] = [];
  const paths: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (!p.startsWith('/app/') && !p.startsWith('/__fake/') && p !== '/inbox') paths.push(`${r.method()} ${p.replace(/it_[A-Za-z0-9_-]+/, '{id}')}`);
  });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(page.locator('.chat-col').getByText('I can hold either room until 6 PM today.')).toBeVisible();
  await expect.poll(() => paths.includes('POST /v2/items/{id}/seen')).toBe(true);
  expect(sockets).toEqual([]);
  expect(paths.filter((p) => p === 'GET /v2/changes')).toHaveLength(1);
  expect(paths.every((p) => p.includes('/v2/') || p === 'GET /__fake/me' || p === 'GET /api/profile')).toBe(true);
  expect((await control(page, 'state')).feeds).toBe(1);
});

test('the chat composer stays usable when answered, when the agent is not listening, and when retracted', async ({ page }) => {
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await page.getByRole('radio', { name: 'Lisboa Plaza' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toContainText('Lisboa Plaza');
  const field = page.getByRole('textbox', { name: 'Write a message' });
  await field.fill('Answered, still writing');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.turn--me', { hasText: 'Answered, still writing' })).toBeVisible();

  await control(page, 'availability', { title: 'Which hotel should I book for Lisbon?', state: 'not_listening' });
  await expect(page.getByTestId('chat-away')).toContainText("isn't listening right now");
  await field.fill('For when you are back');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.turn--me', { hasText: 'For when you are back' })).toBeVisible();

  await control(page, 'retract', { title: 'Which hotel should I book for Lisbon?' });
  await expect(row(page, 'Which hotel should I book for Lisbon?').first()).toBeVisible();
  await field.fill('After the retraction');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.turn--me', { hasText: 'After the retraction' })).toBeVisible();
  await expect(page.getByText('This chat is closed')).toHaveCount(0);
});

test('a message with only choices also takes a written answer', async ({ page }) => {
  await openInbox(page);
  await openRow(page, 'Approve the survey questions?');
  await page.getByRole('radio', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Cut question 9');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toContainText('Cut question 9');
  const frames = (await control(page, 'state')).answerFrames;
  expect(frames.at(-1).body).toEqual({ request_revision: 1, comment: 'Cut question 9' });
});

test('a dropped feed resumes with Last-Event-ID and shows what changed meanwhile', async ({ page }) => {
  await openInbox(page);
  await control(page, 'send', { message: { sender_id: 'agent:news', message_id: 'n1', title: 'Before the drop' } });
  await expect(row(page, 'Before the drop')).toBeVisible();
  await control(page, 'drop-feeds');
  await control(page, 'send', { message: { sender_id: 'agent:news', message_id: 'n2', title: 'During the drop' } });
  await expect(row(page, 'During the drop')).toBeVisible();
  const opens = (await control(page, 'state')).feedOpens as { lastEventId: string | null }[];
  expect(opens.length).toBeGreaterThanOrEqual(2);
  expect(opens.at(-1)!.lastEventId).not.toBeNull();
});

test('an expired cursor reads the whole inbox again: an item removed meanwhile is gone', async ({ page }) => {
  await openInbox(page);
  await expect(row(page, 'Quarterly report is ready')).toBeVisible();
  await control(page, 'expire-cursor', { remove: 'Quarterly report is ready' });
  await expect(row(page, 'Quarterly report is ready')).toHaveCount(0);
  await control(page, 'send', { message: { sender_id: 'agent:news', message_id: 'n3', title: 'After the rebaseline' } });
  await expect(row(page, 'After the rebaseline')).toBeVisible();
});

test('signing out elsewhere ends the feed (revoked) and the tab leaves for sign-in', async ({ page }) => {
  await openInbox(page);
  await control(page, 'end-session');
  await expect(page).toHaveURL(/\/devices$/);
});

test('a paused account keeps the inbox readable and says messages are paused', async ({ page }) => {
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await control(page, 'inactive');
  await expect(page.getByText(/paused/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Which hotel should I book for Lisbon?' })).toBeVisible();
  await expect(page.getByTestId('row').first()).toBeVisible();
});

test('a chat file goes up with POST /v2/files under its own name', async ({ page }) => {
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await page.locator('input[type=file]').setInputFiles([{ name: 'floor plan (v2).pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(5_000, 'c') }]);
  await page.getByRole('textbox', { name: 'Write a message' }).fill('The plan');
  await page.getByRole('button', { name: 'Send message' }).click();
  const turn = page.locator('.turn--me', { hasText: 'The plan' });
  await expect.poll(async () => (await control(page, 'state')).lastDiscussion?.text).toBe('The plan');
  await expect(turn.locator('.file')).toContainText('floor plan (v2).pdf');
  const st = await control(page, 'state');
  expect(st.v2Uploads).toEqual([{ size: 5_000, contentType: 'application/pdf' }]);
  expect(st.lastDiscussion.files[0].name).toBe('floor plan (v2).pdf');
  // It downloads from GET /v2/files/{id}.
  await expect(turn.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /^\/v2\/files\//);
});

test('a custom form’s pictures show with chat files off: they arrive as files, but belong to the message', async ({ page }) => {
  await control(page, 'attachments', { on: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInbox(page);
  await openRow(page, 'Which cover for the November issue?');
  await expect(page.locator('svg image')).toHaveCount(1);
  await expect(page.locator('.u-img-missing')).toHaveCount(0);
});

test('adjacent messages of one sender’s thread draw as one group (Item.thread)', async ({ page }) => {
  await openInbox(page);
  const ask = (id: string) => ({
    sender_id: 'agent:ops',
    message_id: id,
    display_name: 'Ops agent',
    title: `Approve step ${id}`,
    message_type: 'request',
    thread: 'rollout-7',
    answer_ui: { schema: 'attention-client.actions/1', actions: [{ id: 'ok', label: 'OK', kind: 'value', value: 'ok' }] },
  });
  await control(page, 'send', { message: ask('s1') });
  await control(page, 'send', { message: ask('s2') });
  await expect(page.getByText('2 messages from Ops agent')).toBeVisible();
});
