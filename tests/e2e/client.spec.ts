import { expect, test, type Page } from '@playwright/test';

const control = (page: Page, what: string, body: unknown = {}) =>
  page.request.post(`/__fake/${what}`, { data: body }).then((r) => r.json());

test.beforeEach(async ({ page }) => {
  await control(page, 'reset');
});

async function openInbox(page: Page) {
  await page.goto('/inbox');
  await expect(page.getByTestId('row').first()).toBeVisible();
}

test('lists the inbox and opens a message, reporting the open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await expect(page.getByTestId('row')).toHaveCount(6);
  await page.getByText('Which hotel should I book for Lisbon?').first().click();
  await expect(page.getByRole('heading', { name: 'Which hotel should I book for Lisbon?' })).toBeVisible();
  await expect.poll(async () => (await control(page, 'state')).opens).toBe(1);
  // Three columns at wide width: the chat is beside the message.
  await expect(page.getByText('I can hold either room until 6 PM today.')).toBeVisible();
});

test('answers with a choice and shows the answered card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await page.getByText('Approve the survey questions?').first().click();
  const send = page.getByRole('button', { name: 'Send answer' });
  await expect(send).toBeDisabled();
  await page.getByRole('radio', { name: 'Approve' }).click();
  await send.click();
  await expect(page.getByTestId('answered')).toContainText('Answered');
  await expect(page.getByTestId('answered')).toContainText('Approve');
  expect((await control(page, 'state')).lastAnswer.answer).toBe('approve');
  // It moved to Replied.
  await page.getByRole('tab', { name: 'Replied' }).click();
  await expect(page.getByText('Approve the survey questions?').first()).toBeVisible();
});

test('writes a reply in the one-card reply field', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await page.getByText('Production deploy failed').first().click();
  await page.getByRole('radio', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Hold it, I will look after lunch');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toContainText('Hold it, I will look after lunch');
  expect((await control(page, 'state')).lastAnswer.answer).toBe('Hold it, I will look after lunch');
});

test('marks an information message Seen with JSON null', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await page.getByText('Quarterly report is ready').first().click();
  await page.locator('.seen-under').click();
  await expect(page.getByTestId('answered')).toContainText('Seen');
  expect((await control(page, 'state')).lastAnswer.answer).toBe(null);
});

test('chats with the agent and sees the reply live', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await page.getByText('Which hotel should I book for Lisbon?').first().click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('Is breakfast included?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn--me', { hasText: 'Is breakfast included?' })).toBeVisible();
  await expect.poll(async () => (await control(page, 'state')).lastDiscussion?.text).toBe('Is breakfast included?');
  await control(page, 'reply', { sender_id: 'agent:research', message_id: 'lisbon', text: 'Yes, until 10 AM.' });
  await expect(page.getByText('Yes, until 10 AM.')).toBeVisible();
  await expect(page.locator('.turn--me', { hasText: 'Is breakfast included?' })).toContainText('Delivered');
});

test('sends files with a chat message: small inline, large uploaded', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInbox(page);
  await page.getByText('Which hotel should I book for Lisbon?').first().click();
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
  await page.getByText('Which hotel should I book for Lisbon?').first().click();
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
  await page.getByText('Which hotel should I book for Lisbon?').first().click();
  await page.getByRole('radio', { name: 'Lisboa Plaza' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('This chat is closed. You can still read it and download its files.')).toBeVisible();
  await expect(page.getByText('I can hold either room until 6 PM today.')).toBeVisible();
});

test('shows a new message live', async ({ page }) => {
  await openInbox(page);
  await control(page, 'send', { message: { sender_id: 'agent:new', message_id: 'n1', display_name: 'New agent', title: 'Fresh news' } });
  await expect(page.getByText('Fresh news')).toBeVisible();
});

test('phone width shows one column at a time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  await expect(page.getByRole('tab', { name: 'Inbox' })).toBeVisible();
  await page.getByText('Which hotel should I book for Lisbon?').first().click();
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
  await expect(page.getByRole('heading', { name: 'Harklight in the browser is coming soon' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(sockets).toBe(0);
  expect((await control(page, 'state')).connections).toBe(0);

  await page.goto('/inbox#preview');
  await expect(page.getByTestId('row').first()).toBeVisible();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.goto('/inbox#preview-off');
  await expect(page.getByRole('heading', { name: 'Harklight in the browser is coming soon' })).toBeVisible();
});
