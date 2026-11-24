// What became of a chat message's or an answer's handoff to the agent.
import { expect, test, type Page } from '@playwright/test';

const control = async (page: Page, what: string, body: unknown = {}) => {
  const res = await page.request.post(`/__fake/${what}`, { data: body });
  expect(res.ok(), what).toBe(true);
  return res.json();
};
const openRow = (page: Page, title: string) => page.getByTestId('row').filter({ hasText: title }).first().click();
const LINE = 'Not handed to the agent';

/** Make a change while this tab has no feed, so it arrives as reconnect catch-up. */
async function whileAway(page: Page, change: () => Promise<unknown>) {
  const before = (await control(page, 'state')).feedOpens.length;
  await control(page, 'bad-gateway');
  expect((await control(page, 'state')).feeds).toBe(0);
  await change();
  await control(page, 'bad-gateway', { on: false });
  await expect.poll(async () => (await control(page, 'state')).feedOpens.length, { timeout: 20_000 }).toBeGreaterThan(before);
}

test.beforeEach(async ({ page }) => {
  await control(page, 'reset');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox');
  await expect(page.getByTestId('row').first()).toBeVisible();
});

async function sendChat(page: Page, text: string) {
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await page.getByRole('textbox', { name: 'Write a message' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  const turn = page.locator('.turn--me', { hasText: text });
  await expect(turn.locator('.turn-st')).toHaveText('Sent');
  return turn.locator('.turn-st');
}

test('a chat message not handed says so, and reads Delivered once handed, live', async ({ page }) => {
  const text = 'Is the desk by a window?';
  const status = await sendChat(page, text);
  await control(page, 'handoff', { text, outcome: 'not_handed' });
  await expect(status).toHaveText(LINE);
  await expect(page.getByText(LINE, { exact: true })).toBeVisible();
  // The earlier message, delivered with no outcome, is untouched.
  await expect(page.locator('.turn--me', { hasText: 'Does the Avenida have a desk in the room?' }).locator('.turn-st')).toHaveText('Delivered');
  await control(page, 'handoff', { text, outcome: 'handed' });
  await expect(status).toHaveText('Delivered');
  await control(page, 'handoff', { text, outcome: 'not_handed' });
  await expect(status).toHaveText(LINE);
});

test('a chat receipt follows changes made while the tab was away, and a reload', async ({ page }) => {
  const text = 'Is the desk by a window?';
  const status = await sendChat(page, text);
  await whileAway(page, () => control(page, 'handoff', { text, outcome: 'not_handed' }));
  await expect(status).toHaveText(LINE);
  await page.reload();
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(status).toHaveText(LINE);
  await whileAway(page, () => control(page, 'handoff', { text, outcome: 'handed' }));
  await expect(status).toHaveText('Delivered');
});

test('an unknown outcome is no outcome: a chat message shows Delivered, an answer nothing', async ({ page }) => {
  const text = 'Is the desk by a window?';
  const status = await sendChat(page, text);
  await control(page, 'handoff', { text, outcome: 'later' });
  await expect(status).toHaveText('Delivered');
  await page.getByRole('radio', { name: 'Lisboa Plaza' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await control(page, 'handoff', { title: 'Which hotel should I book for Lisbon?', outcome: 'later' });
  // A later change arriving proves this one was already applied.
  await control(page, 'send', { message: { sender_id: 'agent:x', message_id: 'after', title: 'After it' } });
  await expect(page.getByTestId('row').filter({ hasText: 'After it' })).toBeVisible();
  await expect(page.locator('.detail').getByTestId('answered')).toHaveText('Lisboa Plaza');
  await expect(page.getByText(LINE)).toHaveCount(0);
});

const answers: [string, string, (page: Page) => Promise<void>, string][] = [
  ['choice', 'Approve the survey questions?', async (page) => {
    await page.getByRole('radio', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Send answer' }).click();
  }, 'answered'],
  ['reply', 'Approve the survey questions?', async (page) => {
    await page.getByRole('radio', { name: 'Reply' }).click();
    await page.getByRole('textbox', { name: 'Reply' }).fill('Cut question 9');
    await page.getByRole('button', { name: 'Send answer' }).click();
  }, 'answered'],
  ['Seen', 'The hosting card expires next month', async (page) => {
    await page.locator('.detail-bar').getByRole('button', { name: 'Seen' }).click();
  }, 'seen-done'],
  ['custom form', 'Which cover for the November issue?', async (page) => {
    await page.getByRole('radio', { name: /Use cover A/ }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  }, 'answered'],
];

for (const [kind, title, answer, card] of answers) {
  test(`a ${kind} answer not handed says so on its card, until it is handed`, async ({ page }) => {
    await openRow(page, title);
    await answer(page);
    const detail = page.locator('.detail');
    await expect(detail.getByTestId(card)).toBeVisible();
    await expect(page.getByText(LINE)).toHaveCount(0);
    const text = await detail.innerText();

    await control(page, 'handoff', { title, outcome: 'not_handed' });
    await expect(detail.getByText(LINE, { exact: true })).toBeVisible();
    await expect(detail.getByTestId(card)).toBeVisible();

    await control(page, 'handoff', { title, outcome: 'handed' });
    await expect(page.getByText(LINE)).toHaveCount(0);
    expect(await detail.innerText()).toBe(text);

    await whileAway(page, () => control(page, 'handoff', { title, outcome: 'not_handed' }));
    await expect(detail.getByText(LINE, { exact: true })).toBeVisible();
    await whileAway(page, () => control(page, 'handoff', { title, outcome: 'handed' }));
    await expect(page.getByText(LINE)).toHaveCount(0);
  });
}

test('an FYI marked Seen in the list shows a line only while not handed', async ({ page }) => {
  const title = 'The hosting card expires next month';
  await page.goto('/inbox#preview');
  await page.getByRole('button', { name: /^Open FYIs/ }).press('Enter');
  const item = page.getByRole('article').filter({ hasText: title });
  await item.getByRole('button', { name: `Mark seen: ${title}` }).click();
  await expect(item.getByText('Seen', { exact: true })).toBeVisible();
  await expect(page.getByText(LINE)).toHaveCount(0);
  await control(page, 'handoff', { title, outcome: 'not_handed' });
  await expect(item.getByText(LINE, { exact: true })).toBeVisible();
  await control(page, 'handoff', { title, outcome: 'handed' });
  await expect(page.getByText(LINE)).toHaveCount(0);
});
