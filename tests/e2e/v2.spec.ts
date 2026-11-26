// Client API v2 in the browser: the transport, the feed's recovery paths and
// the rules that keep the composer and written answers available.
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

test('an internal feed error pauses live updates and copies safe details from a failed recovery', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openInbox(page);
  await expect.poll(async () => (await control(page, 'state')).feeds).toBe(1);
  await control(page, 'closing', { reason: 'internal_error' });
  const banner = page.getByRole('alert').filter({ hasText: 'Live updates paused.' });
  await expect(banner).toBeVisible();
  await control(page, 'internal-error', { path: '/changes' });
  const batch = page.waitForResponse((res) => new URL(res.url()).pathname === '/v2/changes' && res.status() === 500);
  await banner.getByRole('button', { name: 'Try again' }).click();
  const requestId = (await batch).headers()['request-id'];
  expect(requestId).toBeTruthy();
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Copy details' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Operation: changes\nError: internal_error\nHTTP status: 500\nRequest-Id: ${requestId}`,
  );
  await control(page, 'internal-error', { on: false });
  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await control(page, 'state')).feeds).toBe(1);
});

test('a failed older inbox page is not fetched again by the short-list effect', async ({ page }) => {
  await control(page, 'bulk', { count: 25 });
  let attempts = 0;
  let refuse = true;
  await page.route('**/v2/inbox?page=*', (route) => {
    attempts++;
    return refuse && attempts <= 4
      ? route.fulfill({ status: 500, json: { error: 'internal_error', retryable: false } })
      : route.continue();
  });
  await openInbox(page);
  await page.getByRole('tab', { name: 'Replied' }).click();
  await expect(page.getByRole('button', { name: 'Copy details' })).toBeVisible();
  await expect.poll(() => attempts).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  expect(attempts).toBe(1);
  refuse = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => attempts).toBe(2);
});

test('a failed visible reply read-position write is not repeated by the observer', async ({ page }) => {
  const attempted: string[] = [];
  let refuse = true;
  await page.route('**/v2/items/*/read-position', (route) => {
    attempted.push(route.request().postDataJSON().entry_id);
    return refuse && attempted.length <= 4
      ? route.fulfill({ status: 500, json: { error: 'internal_error', retryable: false } })
      : route.continue();
  });
  await openInbox(page);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(page.getByRole('button', { name: 'Copy details' })).toBeVisible();
  await expect.poll(() => attempted.length).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  expect(attempted).toHaveLength(1);
  refuse = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => attempted.filter((entry) => entry === attempted[0]).length).toBe(2);
});

test('a failed UI/1 picture GET is logged and exposes its Request-Id without repeating', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let attempts = 0;
  let refuse = true;
  await page.route('**/v2/files/*', (route) => {
    attempts++;
    if (!refuse) return route.continue();
    return route.fulfill({ status: 500, headers: { 'Request-Id': 'rq_picture' }, json: { error: 'internal_error', retryable: false } });
  });
  await openInbox(page);
  await openRow(page, 'Which cover for the November issue?');
  await expect(page.locator('.u-img-missing')).toBeVisible();
  await page.getByRole('button', { name: 'Copy details' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Operation: file_preview\nError: internal_error\nHTTP status: 500\nRequest-Id: rq_picture',
  );
  expect(attempts).toBe(1);
  refuse = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('svg image')).toHaveAttribute('href', /^blob:/);
  expect(attempts).toBe(2);
});

test('a successful UI/1 picture does not clear another picture’s failure', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let failFirst = true;
  let firstReads = 0;
  let secondReads = 0;
  let releaseSecond!: () => void;
  const secondReady = new Promise<void>((resolve) => { releaseSecond = resolve; });
  await page.route('**/v2/inbox*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const item = body.items.find((it: { message: { title: string } }) => it.message.title === 'Which cover for the November issue?');
    if (item) {
      item.seen = true;
      const first = item.files[0];
      item.files.push({ ...first, file_id: 'second-picture', name: 'cover-b.avif', content_type: 'image/avif' });
      item.message.answer_ui.illustrations[1].primitives.push({ kind: 'image', x: 0, y: 0, width: 400, height: 240, file: 'cover-b.avif' });
      await page.route(`**/v2/files/${first.file_id}`, (get) => {
        firstReads++;
        return failFirst
          ? get.fulfill({ status: 500, headers: { 'Request-Id': 'rq_first_picture' }, json: { error: 'internal_error', retryable: false } })
          : get.continue();
      });
    }
    await route.fulfill({ response, json: body });
  });
  await page.route('**/v2/files/second-picture', async (route) => {
    secondReads++;
    await secondReady;
    await route.fulfill({ path: 'tests/fixtures/cover-2x2.avif', contentType: 'application/octet-stream' });
  });
  await openInbox(page);
  await openRow(page, 'Which cover for the November issue?');
  const copy = page.getByRole('button', { name: 'Copy details' });
  try {
    await expect(copy).toBeVisible();
  } finally {
    releaseSecond();
  }
  await expect(page.locator('svg image')).toHaveCount(1);
  await expect(page.locator('.u-img-missing')).toHaveCount(1);
  await copy.click({ timeout: 1500 });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Request-Id: rq_first_picture');
  expect([firstReads, secondReads]).toEqual([1, 1]);
  failFirst = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('svg image')).toHaveCount(2);
  await expect(copy).toHaveCount(0);
  expect([firstReads, secondReads]).toEqual([2, 1]);
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

for (const contentType of ['image/avif', 'application/octet-stream']) {
  test(`UI/1 decodes an AVIF illustration with stored type ${contentType}`, async ({ page }) => {
    await page.route('**/v2/inbox*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const item = body.items.find((it: { message: { title: string } }) => it.message.title === 'Which cover for the November issue?');
      if (item) {
        const [file] = item.files;
        if (contentType === 'application/octet-stream') {
          item.message = JSON.parse(JSON.stringify(item.message).replaceAll('cover-a.png', 'cover-a.avif'));
          file.name = 'cover-a.avif';
        }
        file.content_type = contentType;
        await page.route(`**/v2/files/${file.file_id}`, (get) =>
          get.fulfill({ path: 'tests/fixtures/cover-2x2.avif', contentType: 'application/octet-stream' }));
      }
      await route.fulfill({ response, json: body });
    });
    await openInbox(page);
    await openRow(page, 'Which cover for the November issue?');
    const picture = page.locator('svg image');
    await expect(picture).toHaveAttribute('href', /^blob:/);
    const size = await picture.evaluate(async (node) => {
      const image = new Image();
      image.src = node.getAttribute('href')!;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    expect(size).toEqual([2, 2]);
  });
}

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

test('an urgent item is marked, and another device\'s choice shows its label', async ({ page }) => {
  await openInbox(page);
  await expect(row(page, 'Production deploy failed').first()).toHaveClass(/row--urgent/);
  await expect(row(page, 'Approve the survey questions?').first()).not.toHaveClass(/row--urgent|row--high/);
  // Another device answers with a choice: the card names it.
  const inbox = await (await page.request.get('/v2/inbox?limit=200')).json();
  const survey = inbox.items.find((i: { message: { title: string } }) => i.message.title === 'Approve the survey questions?');
  const r = await page.request.post(`/v2/items/${survey.item_id}/answer`, {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: { request_revision: 1, choice: 'approve' },
  });
  expect(r.status()).toBe(200);
  await page.getByRole('tab', { name: 'Replied' }).click();
  await openRow(page, 'Approve the survey questions?');
  await expect(page.getByTestId('answered')).toContainText('Approve');
});

test('a message with no agent conversation has no composer (Chat.available false)', async ({ page }) => {
  await openInbox(page);
  await openRow(page, 'The hosting card expires next month');
  await expect(page.locator('.chat-col')).toContainText('did not open a chat');
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveCount(0);
});

test('shared chat names speakers, shows Seen and the answer, and clears scope on downgrade', async ({ page }) => {
  await control(page, 'shared-messages', { on: true });
  const requests: { path: string; feature?: string; token?: string; after?: string | null; queryFeature?: string | null; queryToken?: string | null; sse?: boolean }[] = [];
  page.on('request', (r) => {
    const { pathname: path, searchParams } = new URL(r.url());
    if (path.startsWith('/v2/')) requests.push({
      path, feature: r.headers()['harklight-features'], token: r.headers()['harklight-continuation'],
      ...(path === '/v2/changes' ? {
        after: searchParams.get('after'), queryFeature: searchParams.get('features'),
        queryToken: searchParams.get('continuation'), sse: r.headers().accept === 'text/event-stream',
      } : {}),
    });
  });
  await openInbox(page);
  await expect(page.getByTestId('reply-row').filter({ hasText: 'Launch date' })).toContainText('2 new');
  const seen = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/seen'));
  await expect(row(page, 'Launch date')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Replied' }).click();
  await openRow(page, 'Launch date');
  expect((await seen).postDataJSON()).toEqual({ request_revision: 2 });
  await expect(page.getByLabel('Shared with')).toContainText('Dana · Seen');
  await expect(page.getByLabel('Shared with')).toContainText('Lee · Unseen');
  await expect(page.getByTestId('answered')).toContainText('Answered by Dana');
  await expect(page.locator('.turn', { hasText: 'Works for me' })).toContainText('Dana');
  await expect(page.locator('.turn', { hasText: 'Works for me' })).not.toContainText('Delivered');
  await expect(page.locator('.turn', { hasText: 'Thursday is available' })).toContainText('Release team');
  await expect(page.locator('.turn', { hasText: 'Chat opened' })).toContainText('Harklight');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('schedule.txt');
  await expect(page.locator('.turn--me', { hasText: 'Checking the date' })).toContainText('You');
  await expect(page.getByTestId('reply-row').filter({ hasText: 'Launch date' })).toHaveCount(0);
  expect(requests.find((r) => r.path === '/v2/me')?.feature).toBeUndefined();
  const firstFeed = requests.find((r) => r.sse && r.queryFeature === 'shared_messages');
  expect(firstFeed).toMatchObject({ queryFeature: 'shared_messages', queryToken: expect.any(String), feature: undefined, token: undefined });
  const optIn = requests.findIndex((r) => r.path === '/v2/inbox' && r.feature === 'shared_messages');
  expect(optIn).toBeGreaterThan(0);
  expect(requests.slice(optIn).filter((r) => !r.sse).every((r) => r.feature === 'shared_messages')).toBe(true);

  const legacyBaseline = page.waitForResponse((r) => new URL(r.url()).pathname === '/v2/inbox' && !r.request().headers()['harklight-features']);
  await control(page, 'shared-messages', { on: false, drop: true });
  const { rev } = await (await legacyBaseline).json();
  await expect(row(page, 'Launch date')).toHaveCount(0);
  await expect.poll(() => requests.filter((r) => r.path === '/v2/changes').at(-1)).toEqual({
    path: '/v2/changes', feature: undefined, token: undefined, after: String(rev),
    queryFeature: null, queryToken: null, sse: true,
  });
});

test('feature off keeps legacy attribution and omits shared request headers', async ({ page }) => {
  await control(page, 'shared-messages', { on: false });
  const headers: Record<string, string>[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/v2/')) headers.push(r.headers());
  });
  await openInbox(page);
  await expect(row(page, 'Launch date')).toHaveCount(0);
  await openRow(page, 'Which hotel should I book for Lisbon?');
  await expect(page.locator('.turn--me').first()).toContainText('You');
  await expect(page.getByLabel('Shared with')).toHaveCount(0);
  expect(headers.every((h) => !h['harklight-features'] && !h['harklight-continuation'])).toBe(true);
});

test('a shared feed rejected with 410 uses a new baseline and continuation', async ({ page }) => {
  await control(page, 'shared-messages', { on: true });
  const tokens: (string | null)[] = [];
  const batches: { feature?: string; token?: string }[] = [];
  const feeds = /\/v2\/changes\?/;
  await page.route(feeds, async (route) => {
    const headers = route.request().headers();
    if (headers.accept !== 'text/event-stream') {
      batches.push({ feature: headers['harklight-features'], token: headers['harklight-continuation'] });
      if (batches.length === 1) {
        await route.fulfill({ status: 410, json: { error: 'cursor_expired', retryable: false } });
      } else await route.continue();
      return;
    }
    const token = new URL(route.request().url()).searchParams.get('continuation');
    if (!token) return route.continue();
    tokens.push(token);
    if (tokens.length === 1) {
      await route.fulfill({ status: 410, json: { error: 'cursor_expired', retryable: false } });
    } else {
      await route.continue();
    }
  });
  await openInbox(page);
  await expect.poll(() => tokens.length).toBe(2);
  expect(tokens[0]).toBeTruthy();
  expect(tokens[1]).toBeTruthy();
  expect(tokens[1]).not.toBe(tokens[0]);
  expect(batches).toEqual([{ feature: 'shared_messages', token: tokens[0] }]);
  await expect.poll(async () => (await control(page, 'state')).feeds).toBe(1);
});


test('the answerer also finds the settled shared message only in Replied', async ({ page }) => {
  await control(page, 'shared-messages', { on: true, viewer: 'answerer' });
  await openInbox(page);
  await expect(row(page, 'Launch date')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Replied' }).click();
  await openRow(page, 'Launch date');
  await expect(page.getByTestId('answered')).toContainText('Answered by Dana');
});

test('shared native reconnect keeps the scoped URL and Last-Event-ID', async ({ page }) => {
  await control(page, 'shared-messages', { on: true });
  const urls: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname === '/v2/changes' && url.searchParams.has('features') && r.headers().accept === 'text/event-stream') urls.push(r.url());
  });
  await openInbox(page);
  await expect.poll(() => urls.length).toBe(1);
  await control(page, 'send', { message: { sender_id: 'example:release', message_id: 'before-drop', title: 'Before the reconnect' } });
  await expect(row(page, 'Before the reconnect')).toBeVisible();
  await control(page, 'drop-feeds');
  await expect.poll(() => urls.length, { timeout: 6000 }).toBe(2);
  expect(urls[1]).toBe(urls[0]);
  const after = Number(new URL(urls[0]).searchParams.get('after'));
  await expect.poll(async () => (await control(page, 'state')).feedOpens.at(-1)).toMatchObject({
    lastEventId: expect.any(String),
  });
  const resumed = (await control(page, 'state')).feedOpens.at(-1);
  expect(resumed.after).toBe(Number(resumed.lastEventId));
  expect(resumed.after).toBeGreaterThan(after);
});

test('the shared SSE fixture refuses duplicate aliases, conflicts and unavailable opt-in', async ({ page }) => {
  await control(page, 'shared-messages', { on: true });
  const shared = 'features=shared_messages&continuation=example';
  for (const [query, headers] of [
    [shared + '&features=shared_messages', {}],
    [shared + '&continuation=example', {}],
    [shared, { 'harklight-features': 'different' }],
    [shared, { 'harklight-continuation': 'different' }],
  ] as const) {
    const response = await page.request.get(`/v2/changes?after=0&${query}`, {
      headers: { accept: 'text/event-stream', ...headers },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_field' });
  }
  await control(page, 'shared-messages', { on: false });
  const response = await page.request.get(`/v2/changes?after=0&${shared}`, { headers: { accept: 'text/event-stream' } });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'unsupported' });
});

test('a held discovery leaves the legacy Inbox live, then upgrades without duplicate rows', async ({ page }) => {
  await control(page, 'shared-messages', { on: true });
  const release = Promise.withResolvers<void>();
  const discovery = page.waitForRequest('**/v2/me');
  await page.route('**/v2/me', async (route) => {
    await release.promise;
    await route.continue();
  });
  const feeds: URL[] = [];
  page.on('request', (request) => {
    if (request.headers().accept === 'text/event-stream') feeds.push(new URL(request.url()));
  });
  try {
    await page.goto('/inbox');
    await discovery;
    const legacy = row(page, 'Which hotel should I book for Lisbon?');
    await expect(legacy).toHaveCount(1);
    await expect.poll(() => feeds.length).toBe(1);
    expect(feeds[0].searchParams.has('features')).toBe(false);
    await expect(page.getByTestId('reply-row').filter({ hasText: 'Launch date' })).toHaveCount(0);

    release.resolve();
    await expect(page.getByTestId('reply-row').filter({ hasText: 'Launch date' })).toHaveCount(1);
    await expect(legacy).toHaveCount(1);
    await expect.poll(() => feeds.length).toBe(2);
    expect(feeds[1].searchParams.get('features')).toBe('shared_messages');
    expect(feeds[1].searchParams.get('continuation')).toBeTruthy();
  } finally {
    release.resolve();
  }
});

test('unshared attachments keep native download links after opting in', async ({ page }) => {
  await control(page, 'shared-messages', { on: true });
  await openInbox(page);
  await expect(page.getByTestId('reply-row').filter({ hasText: 'Launch date' })).toBeVisible();
  await openRow(page, 'Which hotel should I book for Lisbon?');
  const file = page.locator('.chat input[type=file]');
  await file.setInputFiles({ name: 'hotel.txt', mimeType: 'text/plain', buffer: Buffer.from('Hotel details') });
  await page.getByRole('button', { name: 'Send message' }).click();
  const link = page.getByRole('link', { name: 'Download', exact: true }).filter({ visible: true }).last();
  await expect(link).toHaveAttribute('download', 'hotel.txt');
  await expect(link).toHaveAttribute('href', /^\/v2\/files\//);
  const downloaded = page.waitForEvent('download');
  await link.click();
  expect((await downloaded).suggestedFilename()).toBe('hotel.txt');
});
