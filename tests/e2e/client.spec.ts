import { expect, test, type Page } from '@playwright/test';

const control = (page: Page, what: string, body: unknown = {}) =>
  page.request.post(`/__fake/${what}`, { data: body }).then((r) => r.json());

test.beforeEach(async ({ page }) => {
  await control(page, 'reset');
});

/** Open a message from its own row (not a chat reply row about it). */
const openRow = (page: Page, title: string) => page.getByTestId('row').filter({ hasText: title }).first().click();

async function openInbox(page: Page) {
  await page.goto('/inbox');
  await expect(page.getByTestId('row').first()).toBeVisible();
}

test('lists the inbox and opens a message, reporting the open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await expect(page.getByTestId('row')).toHaveCount(8);
  // The browser door takes no subprotocol and the client offers none (B-1).
  expect((await control(page, 'state')).subprotocol).toBe(null);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(page.getByRole('heading', { name: 'Which hotel should I book for Lisbon?' })).toBeVisible();
  await expect.poll(async () => (await control(page, 'state')).opens).toBe(1);
  // Three columns at wide width: the chat is beside the message.
  await expect(page.getByText('I can hold either room until 6 PM today.')).toBeVisible();
});

test('answers with a choice and shows the answered card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Approve the survey questions?');
  const send = page.getByRole('button', { name: 'Send answer' });
  await expect(send).toBeDisabled();
  await page.getByRole('radio', { name: 'Approve' }).click();
  await send.click();
  // Confirmed carries no 'Answered' label: the check and the answer say it.
  await expect(page.getByTestId('answered')).toHaveText('Approve');
  expect((await control(page, 'state')).lastAnswer.answer).toBe('approve');
  // It moved to Replied.
  await page.getByRole('tab', { name: 'Replied' }).click();
  await expect(page.getByText('Approve the survey questions?').first()).toBeVisible();
});

test('writes a reply in the one-card reply field', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Production deploy failed');
  await page.getByRole('radio', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Hold it, I will look after lunch');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toContainText('Hold it, I will look after lunch');
  expect((await control(page, 'state')).lastAnswer.answer).toBe('Hold it, I will look after lunch');
});

test('marks an information message Seen with JSON null', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Quarterly report is ready');
  await page.locator('.seen-under').click();
  await expect(page.getByTestId('seen-done')).toBeVisible();
  expect((await control(page, 'state')).lastAnswer.answer).toBe(null);
});

test('chats with the agent and sees the reply live', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Is breakfast included?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn--me', { hasText: 'Is breakfast included?' })).toBeVisible();
  await expect.poll(async () => (await control(page, 'state')).lastDiscussion?.text).toBe('Is breakfast included?');
  await control(page, 'reply', { sender_id: 'agent:research', message_id: 'lisbon', text: 'Yes, until 10 AM.' });
  await expect(page.getByRole('region', { name: 'Chat' }).getByText('Yes, until 10 AM.')).toBeVisible();
  await expect(page.locator('.turn--me', { hasText: 'Is breakfast included?' })).toContainText('Delivered');
});

test('sends files with a chat message: small inline, large uploaded', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  const small = { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.alloc(20_000, 'a') };
  const big = { name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(600_000, 'b') };
  await page.locator('input[type=file]').setInputFiles([small, big]);
  await expect(page.locator('.pending-files .file')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Two files');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(async () => (await control(page, 'state')).lastDiscussion?.text).toBe('Two files');
  await expect(page.locator('.turn--me', { hasText: 'Two files' }).locator('.file')).toHaveCount(2);
  const files = (await control(page, 'state')).lastDiscussion.files;
  expect(files.map((f: { name: string; tier: string }) => [f.name, f.tier])).toEqual([
    ['note.txt', 'inline'],
    ['plan.pdf', 'upload'],
  ]);
});

test('refuses a file over the Server limit and sends nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  // Learn the limit, as the client does before it shows one.
  await page.getByRole('textbox', { name: 'Write a message' }).fill('first');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn--me', { hasText: 'first' })).toBeVisible();
  const huge = { name: 'video.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(2_100_000, 'c') };
  await page.locator('input[type=file]').setInputFiles([huge]);
  await expect(page.getByRole('alert')).toContainText('video.mov is larger than the 2 MB limit. Nothing was sent.');
  await expect(page.locator('.pending-files .file')).toHaveCount(0);
});

test('closes the chat once the message is answered, keeping it readable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await page.getByRole('radio', { name: 'Lisboa Plaza' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('This chat is closed. You can still read it and download its files.')).toBeVisible();
  await expect(page.getByText('I can hold either room until 6 PM today.')).toBeVisible();
});

test('shows a new message live', async ({ page }) => {
  await openInbox(page);
  await control(page, 'send', { message: { sender_id: 'agent:new', message_id: 'n1', display_name: 'New agent', title: 'Fresh news' } });
  await expect(page.getByTestId('row').filter({ hasText: 'Fresh news' })).toBeVisible();
});

test('phone width shows one column at a time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  await expect(page.getByRole('tab', { name: 'Inbox' })).toBeVisible();
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(page.getByTestId('row')).toHaveCount(0);
  await page.getByRole('button', { name: /^Chat/ }).click();
  await expect(page.getByText('Yes. Every room has a desk and wired internet.')).toBeVisible();
  await page.getByRole('button', { name: 'Back to message' }).click();
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(page.getByTestId('row').first()).toBeVisible();
});

test('settings show the account and sign out asks first, then ends the session', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Dana Reyes')).toBeVisible();
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');
  await expect(page.getByRole('link', { name: 'Plan and billing' })).toHaveAttribute('href', '/account/');
  await expect(page.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute('href', '/components');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign out of Harklight?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/account\/sign-out$/);
});

test('a sign-in that ends sends the tab to sign-in', async ({ page }) => {
  await openInbox(page);
  await control(page, 'end-session');
  await expect(page).toHaveURL(/\/devices$/);
});

test('an account that cannot use messaging says so and links to the account page', async ({ page }) => {
  await openInbox(page);
  await control(page, 'inactive');
  await expect(page.getByRole('link', { name: 'Open your account' })).toHaveAttribute('href', '/account/');
});

test('a dropped connection shows reconnecting and recovers', async ({ page }) => {
  await openInbox(page);
  await control(page, 'drop');
  await control(page, 'send', { message: { sender_id: 'agent:new', message_id: 'away', title: 'Sent while away' } });
  await expect(page.getByText('Sent while away')).toBeVisible();
});

test('with the web client off for customers, the page opens no connection; #preview turns it on in this browser', async ({ page }) => {
  await control(page, 'web-client', { on: false });
  let sockets = 0;
  page.on('websocket', () => sockets++);
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Web messaging is coming soon' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to your devices' })).toHaveAttribute('href', '/devices');
  await page.waitForTimeout(300);
  expect(sockets).toBe(0);
  expect((await control(page, 'state')).connections).toBe(0);

  await page.goto('/inbox#preview');
  await expect(page.getByTestId('row').first()).toBeVisible();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.goto('/inbox#preview-off');
  await expect(page.getByRole('heading', { name: 'Web messaging is coming soon' })).toBeVisible();
});

test('answers a custom form: marks a point on the floor plan and adds a note', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInbox(page);
  await openRow(page, 'Where should the repair crew start?');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await send.click();
  await expect(page.getByRole('alert')).toHaveText('Complete the response before sending your answer.');
  const plan = page.getByRole('img', { name: /Floor plan/ });
  const box = (await plan.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await expect(page.getByText(/Horizontal 25\d, vertical 500/)).toBeVisible();
  await page.getByPlaceholder('Note').fill('Start by the door');
  await send.click();
  await expect(page.getByTestId('answered')).toContainText('Start by the door');
  const answer = (await control(page, 'state')).lastAnswer.answer;
  expect(answer.note).toBe('Start by the door');
  expect(answer.drawingRevision).toBe(7);
  expect(answer.point.y).toBe(500);
  // The form's closing scene shows under the Answered card.
  await expect(page.getByText('Location request closed')).toBeVisible();
});

test('a custom form answered with No comment shows its closing scene under the card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInbox(page);
  await openRow(page, 'Which cover for the November issue?');
  await page.getByRole('radio', { name: 'No comment' }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('answered')).toContainText('No comment');
  await expect(page.getByText('Cover chosen')).toBeVisible();
});

test('answers a custom form with pictures: picks a cover', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInbox(page);
  await openRow(page, 'Which cover for the November issue?');
  await expect(page.locator('svg image')).toHaveCount(1);
  await page.getByRole('radio', { name: /Use cover B/ }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('answered')).toContainText('Use cover B');
  expect((await control(page, 'state')).lastAnswer.answer).toEqual({ cover: 'B' });
});

test('draws the Server view: a chat reply row opens the chat without reporting an open, and finished messages sit under History', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  const reply = page.getByTestId('reply-row').filter({ hasText: 'Which hotel should I book for Lisbon?' });
  await expect(reply).toContainText('Yes. Every room has a desk and wired internet.');
  await expect(page.getByText('History', { exact: true })).toBeVisible();
  await reply.click();
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible();
  expect((await control(page, 'state')).opens).toBe(0);
});

test('Replied loads older pages even when it starts empty and cannot scroll', async ({ page }) => {
  await control(page, 'bulk', { count: 25 });
  await control(page, 'answer-oldest');
  await page.goto('/inbox');
  await page.getByRole('tab', { name: 'Replied' }).click();
  await expect(page.getByTestId('row').first()).toBeVisible();
});

test('a chat refused because the account cannot use messaging shows the account notice', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await control(page, 'refuse-inactive');
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Hello?');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Open your account' })).toBeVisible();
});

test('#preview turns chat files on in this browser even when the deployment has them off', async ({ page }) => {
  await control(page, 'attachments', { on: false });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(page.getByRole('button', { name: 'Attach a file' })).toHaveCount(0);
  await page.goto('/inbox#preview');
  await expect(page.getByTestId('row').first()).toBeVisible();
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(page.getByRole('button', { name: 'Attach a file' })).toBeVisible();
  await page.goto('/inbox#preview-off');
});

test('a choice shows its own sending state, then becomes the answered card, and its row keeps in step', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await control(page, 'hold-answers');
  await openRow(page, 'Approve the survey questions?');
  await page.getByRole('radio', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  // Sending: the tapped choice spins, the others step back, the row spins, no status text.
  await expect(page.locator('.choice--sending')).toContainText('Approve');
  await expect(page.locator('.choice--dim').first()).toBeVisible();
  // The checkmark is only disabled: the picked choice carries the spinner.
  await expect(page.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  await expect(page.locator('.tool--commit .spinner')).toHaveCount(0);
  await expect(page.getByTestId('row').filter({ hasText: 'Approve the survey questions?' }).getByRole('img', { name: 'Sending' })).toBeVisible();
  await expect(page.locator('.msg-note--bad')).toHaveCount(0);
  await control(page, 'release-answers');
  await expect(page.getByTestId('answered')).toContainText('Approve');
  await expect(page.getByRole('img', { name: 'Sending' })).toHaveCount(0);
});

test('a failed choice shows the failure mark with Retry, no Not sent, and Retry sends the same answer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await control(page, 'fail-answers');
  await openRow(page, 'Approve the survey questions?');
  await page.getByRole('radio', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  const failed = page.getByTestId('choice-failed');
  await expect(failed.getByRole('img', { name: "Couldn't send" })).toBeVisible();
  await expect(failed.locator('svg.icon')).toBeVisible();
  await expect(failed).not.toContainText('Not sent');
  await expect(page.getByTestId('row').filter({ hasText: 'Approve the survey questions?' }).getByRole('img', { name: "Couldn't send" })).toBeVisible();
  // The other choices are tappable again.
  await expect(page.getByRole('radio', { name: 'No comment' })).toBeEnabled();
  await control(page, 'fail-answers', { on: false });
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('answered')).toContainText('Approve');
});

test('a written reply spins in the send button while sending', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await control(page, 'hold-answers');
  await openRow(page, 'Production deploy failed');
  await page.getByRole('radio', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Roll it back');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByRole('button', { name: 'Sending', exact: true })).toBeDisabled();
  await expect(page.locator('.tool--commit .spinner')).toHaveCount(1);
  await control(page, 'release-answers');
  await expect(page.getByTestId('answered')).toContainText('Roll it back');
});

test('a failed reply keeps its text and the send control comes back as Retry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await control(page, 'fail-answers');
  await openRow(page, 'Production deploy failed');
  await page.getByRole('radio', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Hold until I look at the logs');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('reply-failed').getByRole('img', { name: "Couldn't send" })).toBeVisible();
  await expect(page.getByTestId('reply-failed')).not.toContainText('Not sent');
  await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveValue('Hold until I look at the logs');
  await control(page, 'fail-answers', { on: false });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('answered')).toContainText('Hold until I look at the logs');
});

test('a failed reply is held as sent: Retry resends it unchanged, Edit makes a new answer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await control(page, 'fail-answers');
  await openRow(page, 'Production deploy failed');
  await page.getByRole('radio', { name: 'Reply' }).click();
  const box = page.getByRole('textbox', { name: 'Reply' });
  await box.fill('Roll back now');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('reply-failed').getByRole('img', { name: "Couldn't send" })).toBeVisible();
  await expect(page.getByTestId('reply-failed')).not.toContainText('Not sent');
  // What is shown is what Retry sends: the text cannot change under it.
  await expect(box).toHaveAttribute('readonly', '');
  await box.press('End');
  await box.pressSequentially(' later', { delay: 0 });
  await expect(box).toHaveValue('Roll back now');
  // The send shortcut does not send a locked answer: only Retry does.
  await box.press('Control+Enter');
  await box.press('Meta+Enter');
  await expect(page.getByTestId('reply-failed')).toBeVisible();
  expect((await control(page, 'state')).answerFrames).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('reply-failed')).toBeVisible();
  let frames = (await control(page, 'state')).answerFrames;
  expect(frames).toHaveLength(2);
  expect(frames[1]).toEqual(frames[0]);
  // Edit turns it back into a draft; its send is a new answer.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(box).not.toHaveAttribute('readonly', '');
  await box.fill('Hold the deploy');
  await control(page, 'fail-answers', { on: false });
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toContainText('Hold the deploy');
  frames = (await control(page, 'state')).answerFrames;
  expect(frames).toHaveLength(3);
  expect(frames[2].op_id).not.toEqual(frames[0].op_id);
  expect(frames[2].answer).toEqual('Hold the deploy');
});

test('a failed reply keeps its text and Retry after leaving the message and coming back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await control(page, 'fail-answers');
  await openRow(page, 'Production deploy failed');
  await page.getByRole('radio', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Page the database owner');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('reply-failed')).toBeVisible();
  await openRow(page, 'Quarterly report is ready');
  await openRow(page, 'Production deploy failed');
  await expect(page.getByTestId('reply-failed').getByRole('img', { name: "Couldn't send" })).toBeVisible();
  await expect(page.getByTestId('reply-failed')).not.toContainText('Not sent');
  await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveValue('Page the database owner');
  await control(page, 'fail-answers', { on: false });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('answered')).toContainText('Page the database owner');
  const frames = (await control(page, 'state')).answerFrames;
  expect(frames[1]).toEqual(frames[0]);
});

test('a failed custom form shows Retry with the failure mark, keeps its answer when reopened, and Retry sends the same answer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInbox(page);
  await control(page, 'fail-answers');
  await openRow(page, 'Which cover for the November issue?');
  await page.getByRole('radio', { name: /Use cover B/ }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('form-failed')).toHaveText('Retry');
  await expect(page.getByTestId('form-failed').getByRole('img', { name: "Couldn't send" })).toBeVisible();
  await expect(page.getByText('Not sent')).toHaveCount(0);
  await expect(page.getByRole('button', { name: "Couldn't send Retry", exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(page.getByTestId('row').filter({ hasText: 'Which cover for the November issue?' }).getByRole('img', { name: "Couldn't send" })).toBeVisible();
  // Leave and come back: the answer as sent, and its Retry, are still there.
  await openRow(page, 'Quarterly report is ready');
  await openRow(page, 'Which cover for the November issue?');
  await expect(page.getByTestId('form-failed')).toBeVisible();
  await expect(page.getByRole('radio', { name: /Use cover B/ })).toHaveAttribute('aria-checked', 'true');
  await control(page, 'fail-answers', { on: false });
  await page.getByTestId('form-failed').click();
  await expect(page.getByTestId('answered')).toContainText('Use cover B');
  const frames = (await control(page, 'state')).answerFrames;
  expect(frames).toHaveLength(2);
  expect(frames[1]).toEqual(frames[0]);
});

for (const [reason, line] of [
  ['closed', 'This message was already closed.'],
  ['retracted', 'The sender retracted this message.'],
] as const) {
  test(`an answer refused because the message was ${reason} shows a reason line and no Retry`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openInbox(page);
    await control(page, 'refuse-answers', { reason });
    await openRow(page, 'Approve the survey questions?');
    await page.getByRole('radio', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Send answer' }).click();
    await expect(page.getByTestId('refused-reason')).toHaveText(line);
    await expect(page.getByRole('button', { name: /Retry/ })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
    await expect(page.getByText('Not sent')).toHaveCount(0);
    await expect(page.getByTestId('row').filter({ hasText: 'Approve the survey questions?' }).getByRole('img', { name: "Couldn't send" })).toHaveCount(0);
    expect((await control(page, 'state')).answerFrames).toHaveLength(1);
  });
}

test('Seen spins while sending, comes back as Retry Seen on failure, and confirms with its check', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await control(page, 'fail-answers');
  await openRow(page, 'Quarterly report is ready');
  await page.locator('.seen-under').click();
  await expect(page.getByRole('button', { name: 'Retry Seen' }).first()).toBeVisible();
  await control(page, 'fail-answers', { on: false });
  await control(page, 'hold-answers');
  await page.getByRole('button', { name: 'Retry Seen' }).first().click();
  await expect(page.locator('.seen-under[aria-busy="true"]')).toBeVisible();
  await control(page, 'release-answers');
  await expect(page.getByTestId('seen-done')).toBeVisible();
});
