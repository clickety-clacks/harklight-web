// The caption under a chat message: what is known of it reaching the agent.
import { expect, test, type Locator, type Page } from '@playwright/test';

const control = async (page: Page, what: string, body: unknown = {}) => {
  const res = await page.request.post(`/__fake/${what}`, { data: body });
  expect(res.ok(), what).toBe(true);
  return res.json();
};
const TITLE = 'Which hotel should I book for Lisbon?';
const TEXT = 'Is the desk by a window?';
const AGENT = { sender_id: 'agent:research', message_id: 'lisbon' };
const openRow = (page: Page, title: string) => page.getByTestId('row').filter({ hasText: title }).first().click();
const set = (page: Page, delivery: object, text = TEXT) => control(page, 'delivery', { text, delivery });
const caption = (page: Page, text: string) => page.locator('.turn--me', { hasText: text }).locator('.turn-st');

/** Make a change while this tab has no feed, so it arrives as reconnect catch-up. */
async function whileAway(page: Page, change: () => Promise<unknown>) {
  const before = (await control(page, 'state')).feedOpens.length;
  await control(page, 'bad-gateway');
  expect((await control(page, 'state')).feeds).toBe(0);
  await change();
  await control(page, 'bad-gateway', { on: false });
  await expect.poll(async () => (await control(page, 'state')).feedOpens.length, { timeout: 20_000 }).toBeGreaterThan(before);
}

/** A later change arrives: everything before it has been applied. */
async function settled(page: Page, id: string) {
  await control(page, 'send', { message: { sender_id: 'agent:x', message_id: id, title: `After ${id}` } });
  await expect(page.getByTestId('row').filter({ hasText: `After ${id}` })).toBeVisible();
}

async function sendChat(page: Page, text: string): Promise<Locator> {
  await page.getByRole('textbox', { name: 'Write a message' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(caption(page, text)).toHaveText('Sent');
  return caption(page, text);
}

test.beforeEach(async ({ page }) => {
  await control(page, 'reset');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/inbox');
  await openRow(page, TITLE);
});

test('served alone stays Sending, capable or unknown, however long passes', async ({ page }) => {
  await page.clock.install();
  await page.goto('/inbox');
  await openRow(page, TITLE);
  const unknown = await sendChat(page, TEXT);
  const capable = await sendChat(page, 'And quiet?');
  // Also what a drop after the Server's pre-write mark leaves behind.
  await set(page, { delivered: true });
  await set(page, { delivered: true, ack2_expected: true }, 'And quiet?');
  await expect(unknown).toHaveText('Sending…');
  await expect(capable).toHaveText('Sending…');
  await page.clock.runFor(60_000);
  await page.clock.fastForward('26:00:00');
  await expect(unknown).toHaveText('Sending…');
  await expect(capable).toHaveText('Sending…');
});

test('not handed, then handed, live', async ({ page }) => {
  const c = await sendChat(page, TEXT);
  await set(page, { delivered: true, acted: true, outcome: 'not_handed' });
  await expect(c).toHaveText('Not delivered');
  await set(page, { reason: 'The **session** ended <b>early</b>' });
  await expect(c).toHaveText('Not delivered: The **session** ended <b>early</b>');
  await expect(page.getByText('Not delivered: The **session** ended <b>early</b>', { exact: true })).toBeVisible();
  await set(page, { outcome: 'handed', reason: null });
  await expect(c).toHaveText('Delivered');
  // The earlier message, answered by the agent, reads Delivered throughout.
  await expect(caption(page, 'Does the Avenida have a desk in the room?')).toHaveText('Delivered');
});

test('not handed, then handed, while the tab was away, and after a reload', async ({ page }) => {
  const c = await sendChat(page, TEXT);
  await whileAway(page, () => set(page, { delivered: true, outcome: 'not_handed' }));
  await expect(c).toHaveText('Not delivered');
  await page.reload();
  await openRow(page, TITLE);
  await expect(c).toHaveText('Not delivered');
  await whileAway(page, () => set(page, { outcome: 'handed' }));
  await expect(c).toHaveText('Delivered');
});

test('a reply to this message outweighs not handed; a reply to another does not', async ({ page }) => {
  const c = await sendChat(page, TEXT);
  const other = await sendChat(page, 'And quiet?');
  await set(page, { delivered: true, outcome: 'not_handed' });
  await set(page, { delivered: true }, 'And quiet?');
  await control(page, 'reply', { ...AGENT, text: 'Quiet, yes.', to: 'And quiet?' });
  await expect(other).toHaveText('Delivered');
  await expect(c).toHaveText('Not delivered');
  await control(page, 'reply', { ...AGENT, text: 'By the window.', to: TEXT });
  await expect(c).toHaveText('Delivered');
  await control(page, 'withdraw-reply', { text: 'By the window.' });
  await expect(c).toHaveText('Not delivered');
  await expect(other).toHaveText('Delivered');
});

for (const [name, delivery, want] of [
  ['the agent saw it', { delivered: true, outcome: 'not_handed', agent_seen: true }, 'Delivered'],
  ['the agent acted on it', { delivered: true, agent_acted: true }, 'Delivered'],
  ['handed to another named agent', { delivered: true, outcome: 'handed', rerouted: true, agent: 'Night desk' }, 'Delivered to Night desk'],
  ['handed to another unnamed agent', { delivered: true, outcome: 'handed', rerouted: true }, 'Delivered'],
  ['no receipt expected, listener confirmed', { delivered: true, ack2_expected: false, listener_received: true }, 'Delivered'],
  ['no receipt expected, listener not confirmed', { delivered: true, ack2_expected: false }, 'Sending…'],
  ['an unknown outcome', { delivered: true, outcome: 'later', ack2_expected: 'no' }, 'Sending…'],
  ['an older Server: acted, none of the new members', { delivered: true, acted: true }, 'Sending…'],
] as const) {
  test(`${name} reads ${want}`, async ({ page }) => {
    const c = await sendChat(page, TEXT);
    await set(page, delivery);
    await expect(c).toHaveText(want);
    await settled(page, 'it');
    await expect(c).toHaveText(want);
  });
}

test('an old message no receipt will come for shows no caption, and a later outcome applies', async ({ page }) => {
  const c = await sendChat(page, TEXT);
  await set(page, { delivered: true, receipt_expected: false });
  await expect(c).toHaveCount(0);
  await set(page, { outcome: 'not_handed' });
  await expect(c).toHaveText('Not delivered');
  await set(page, { outcome: 'handed' });
  await expect(c).toHaveText('Delivered');
});

test('before it is served, the caption follows whether the agent is there', async ({ page }) => {
  const c = await sendChat(page, TEXT);
  await control(page, 'availability', { title: TITLE, state: 'not_listening' });
  await expect(c).toHaveText('Not delivered yet');
  await control(page, 'availability', { title: TITLE, state: 'gone' });
  await expect(c).toHaveText('No one will get this');
  await control(page, 'availability', { title: TITLE, state: 'listening' });
  await expect(c).toHaveText('Sent');
});

for (const state of ['gone', 'unsupported']) {
  test(`a conversation that is ${state} says no one will get it, served or not, unless the agent has it`, async ({ page }) => {
    const served = await sendChat(page, TEXT);
    const unserved = await sendChat(page, 'And quiet?');
    await set(page, { delivered: true });
    await expect(served).toHaveText('Sending…');
    await control(page, 'availability', { title: TITLE, state });
    await expect(served).toHaveText('No one will get this');
    await expect(unserved).toHaveText('No one will get this');
    await set(page, { agent_seen: true });
    await expect(served).toHaveText('Delivered');
    await set(page, { outcome: 'handed' }, 'And quiet?');
    await expect(unserved).toHaveText('Delivered');
  });
}
