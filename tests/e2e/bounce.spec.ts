import { expect, test, type Page } from '@playwright/test';

const survey = 'Approve the survey questions?';
const notice = 'Quarterly report is ready';
const reason = 'Moved out of your inbox because it wasn’t opened.';
const bounced = { kind: 'full', at_ms: 1234, reason: 'unopened' };

async function fake(page: Page, path: string, data: unknown = {}) {
  expect((await page.request.post(`/__fake/${path}`, { data })).ok()).toBe(true);
}

function row(page: Page, title: string) {
  return page.getByTestId('row').filter({ hasText: title });
}

async function config(page: Page, fullBounces?: boolean) {
  await page.route('**/app/config.json', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.flags.fyiInbox = true;
    if (fullBounces !== undefined) json.flags.fullBounces = fullBounces;
    await route.fulfill({ response, json });
  });
}

function writes(page: Page) {
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/(answer|seen)$/.test(path)) {
      const [, itemId, op] = path.split('/').slice(-3);
      const messageId = Buffer.from(itemId.slice(3), 'base64url').toString().split('\0').at(-1);
      writes.push(`${messageId}/${op} ${request.postDataJSON()?.choice ?? ''}`.trim());
    }
  });
  return writes;
}

test('the default-off flag keeps the ordinary inbox, FYI count and Seen behavior', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'standard-order');
  await fake(page, 'bounce', { title: survey, bounced, resolved: true });
  await fake(page, 'bounce', { title: notice, bounced, resolved: true });
  await config(page);
  const sent = writes(page);
  await page.goto('/inbox');
  await expect(page.getByRole('button', { name: 'Open FYIs, 2 unseen' })).toBeVisible();
  await expect(page.getByText('Unopened', { exact: true })).toHaveCount(0);
  await row(page, survey).click();
  await expect(page.getByRole('radio', { name: 'Approve' })).toBeVisible();
  await expect(page.getByText(reason, { exact: false })).toHaveCount(0);
  await expect.poll(() => sent).toEqual(['survey/seen']);
});

for (const grouped of [false, true]) {
  test(`full bounces join History with grouped rank: ${grouped}`, async ({ page }) => {
    await fake(page, 'reset');
    if (!grouped) await fake(page, 'standard-order');
    const expired = 'Which hotel should I book for Lisbon?';
    await fake(page, 'expire', { title: expired });
    await fake(page, 'bounce', { title: survey, bounced, resolved: true });
    await fake(page, 'bounce', { title: notice, bounced, resolved: true });
    await fake(page, 'send', {
      message: {
        sender_id: 'agent:status', message_id: 'progress', title: 'Build progress', message_type: 'fyi',
        progress: { percent: 50, stage: 'Building', updated_at: '2025-01-01T00:00:00Z', segments: [] },
        answer_ui: {
          schema: 'attention-client.actions/1',
          actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: { acknowledgment: 'seen' } }],
        },
      },
    });
    await fake(page, 'bounce', { title: 'Build progress', bounced });
    await config(page, true);
    const sent = writes(page);

    await page.goto('/inbox');
    const summary = page.getByRole('button', { name: 'Open FYIs, 2 unseen' });
    await expect(summary).toContainText('Build progress');
    const history = page.locator('.list-heading').filter({ hasText: /^History$/ });
    await expect(history).toHaveCount(1);
    const historyRows = history.locator('xpath=following-sibling::*[@data-testid="row"]');
    await expect(historyRows.filter({ hasText: 'Unopened' })).toHaveCount(2);
    await expect(historyRows.filter({ hasText: expired })).toHaveCount(grouped ? 1 : 0);
    await expect(row(page, survey)).toHaveCount(1);
    await expect(row(page, notice)).toHaveClass(/row--history/);

    await row(page, notice).click();
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Seen', exact: true })).toHaveCount(0);
    await summary.click();
    await expect(page.locator('.fyi-open')).toHaveCount(2);
    await page.getByRole('button', { name: 'Mark All Seen' }).click();
    await expect(page.getByText('All FYIs are seen')).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent).toContain('progress/seen');
    expect(sent.some((write) => write.startsWith('quarterly/'))).toBe(false);
    await page.getByRole('button', { name: 'Back to Inbox' }).click();

    await row(page, survey).click();
    await expect(page.getByText(`${reason} You can still answer.`, { exact: true })).toBeVisible();
    const chat = page.getByRole('textbox', { name: 'Write a message' });
    await chat.fill('Can we add one question?');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.turn--me', { hasText: 'Can we add one question?' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'No comment' })).toBeEnabled();
    await page.getByRole('radio', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Send answer' }).click();
    await expect(page.getByTestId('answered')).toContainText('Approve');
    await expect(row(page, survey)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Replied' }).click();
    await expect(row(page, survey)).not.toContainText('Unopened');
    expect(sent.filter((write) => write.startsWith('survey/'))).toEqual(['survey/answer approve']);
  });
}

test('Mark All Seen skips a FYI that bounces during the batch', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'hold-answers');
  await config(page, true);
  const sent = writes(page);
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Open FYIs, 2 unseen' }).click();
  await page.getByRole('button', { name: 'Mark All Seen' }).click();
  await expect.poll(() => sent.length).toBe(1);

  const waiting = sent[0].startsWith('quarterly/') ? 'The hosting card expires next month' : notice;
  await fake(page, 'bounce', { title: waiting, bounced, resolved: true });
  await expect(page.getByRole('button', { name: waiting, exact: true })).toHaveCount(0);
  await fake(page, 'release-answers');
  await expect(page.getByText('All FYIs are seen')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await expect(row(page, waiting)).toContainText('Unopened');
  expect(sent).toHaveLength(1);
});

test('a phone can copy an Unopened message ID, revisit with Forward and send No comment', async ({ page }) => {
  await fake(page, 'reset');
  await fake(page, 'standard-order');
  await fake(page, 'bounce', { title: survey, bounced });
  await config(page, true);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const sent = writes(page);
  await page.goto('/inbox');
  await row(page, survey).click();
  const detail = page.getByText(`${reason} You can still answer.`, { exact: true });
  await expect(detail).toBeVisible();
  const copy = page.getByRole('button', { name: 'Copy message ID' });
  const itemId = await copy.getAttribute('aria-description');
  expect(itemId).toMatch(/^it_/);
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(itemId);
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(row(page, survey)).toBeVisible();
  await page.goForward();
  await expect(detail).toBeVisible();
  expect(sent).toEqual([]);
  await page.getByRole('radio', { name: 'No comment' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('answered')).toContainText('No comment');
  expect(sent).toEqual(['survey/answer']);
});
