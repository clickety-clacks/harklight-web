// @vitest-environment node
// The client API v2 session against the fake Server's /v2 door. These are
// the web side's red-first tests from the client API spec, section 10.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error the fake server is plain JavaScript
import { startFakeServer } from '../../../dev/fake-server.mjs';
import { DEFAULT_CONFIG } from '../../../src/config';
import { Store } from '../../../src/state/store';
import { keyOf } from '../../../src/state/types';
import { V2Session } from '../../../src/v2/session';
import { NodeEventSource } from './node-eventsource';

let server: { port: number; close: () => Promise<void> };
const base = () => `http://127.0.0.1:${server.port}`;
const post = (path: string, body: unknown = {}) =>
  fetch(`${base()}/__fake/${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const fakeState = () => fetch(`${base()}/__fake/state`).then((r) => r.json());

function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => (fn() ? resolve() : Date.now() > end ? reject(new Error('timed out')) : setTimeout(tick, 10));
    tick();
  });
}

const itemId = (sender: string, message: string) => `it_${Buffer.from(`${sender}\u0000${message}`).toString('base64url')}`;
const keyFor = (sender: string, message: string) => keyOf({ sender_id: sender, message_id: itemId(sender, message) });
const LISBON = keyFor('agent:research', 'lisbon');
const SURVEY = keyFor('agent:research', 'survey');
const DEPLOY = keyFor('agent:deploy', 'deploy-failed');

interface Harness {
  s: V2Session;
  store: Store;
  sources: NodeEventSource[];
  ended: () => boolean;
  requests: { method: string; url: string; key: string | null }[];
}

function session(opts: { fetch?: typeof fetch } = {}): Harness {
  const store = new Store();
  const sources: NodeEventSource[] = [];
  const requests: Harness['requests'] = [];
  let ended = false;
  const f = opts.fetch ?? fetch;
  const s = new V2Session({
    config: DEFAULT_CONFIG,
    store,
    origin: base(),
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ method: init?.method ?? 'GET', url: String(input), key: h['idempotency-key'] ?? null });
      return f(input, init);
    }) as typeof fetch,
    eventSource: (url) => {
      const es = new NodeEventSource(url);
      sources.push(es);
      return es;
    },
    // Retries run at once in tests.
    setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
    onSessionEnded: () => (ended = true),
  });
  return { s, store, sources, ended: () => ended, requests };
}

const live = (h: Harness) => h.sources.filter((x) => x.readyState !== 2);

beforeEach(async () => {
  server = await startFakeServer({ port: 0, vite: false, dist: 'dist', flags: [] });
});
afterEach(async () => {
  await server.close();
});

describe('client API v2 session', () => {
  it('reads the inbox, opens one feed from its rev, and lists items in rank order', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    expect(h.store.state.messages.size).toBe(6);
    expect(h.sources).toHaveLength(1);
    const after = Number(new URL(h.sources[0].url).searchParams.get('after'));
    expect(after).toBeGreaterThan(0);
    // The most urgent open item comes first; the answered one last.
    const order = h.store.state.view!.listItems!.map((i) => i.key);
    expect(order[0]).toBe(DEPLOY);
    expect(h.store.state.messages.get(order[order.length - 1])!.terminal?.outcome?.kind).toBe('seen');
    h.s.stop();
  });

  it('receives a new item and a chat reply live on the feed', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    h.s.messageOpened(h.store.state.messages.get(LISBON)!);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    await post('send', { message: { sender_id: 'agent:new', message_id: 'n1', title: 'Fresh one' } });
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'Fresh one'));
    await post('reply', { sender_id: 'agent:research', message_id: 'lisbon', text: 'Booked.' });
    await until(() => h.store.state.threads.get(LISBON)!.turns.some((t) => t.text === 'Booked.'));
    expect(h.store.state.messages.get(LISBON)!.v2!.lastOriginReply).not.toBeNull();
    h.s.stop();
  });

  it('runs reads and writes in parallel while the feed is open', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('hold-answers');
    // An answer is held at the Server; reads, a chat reply and Seen go on beside it.
    void h.s.answer(h.store.state.messages.get(SURVEY)!, 'approve', 'Approve', { control: 'approve' });
    await until(() => h.store.state.answers.get(SURVEY)?.state === 'sending');
    h.s.messageOpened(h.store.state.messages.get(LISBON)!);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    await h.s.chat(h.store.state.messages.get(LISBON)!, 'While that answer waits', []);
    await until(() => h.store.state.threads.get(LISBON)!.turns.some((t) => t.text === 'While that answer waits'));
    await until(() => h.store.state.messages.get(LISBON)!.v2!.seen);
    expect(h.store.state.answers.get(SURVEY)?.state).toBe('sending');
    expect(live(h)).toHaveLength(1);
    await post('release-answers');
    await until(() => h.store.state.answers.get(SURVEY)?.state === 'accepted');
    expect(h.store.state.messages.get(SURVEY)!.terminal?.state).toBe('answered');
    h.s.stop();
  });

  it('resumes a dropped feed with Last-Event-ID and misses nothing', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const es = h.sources[0];
    // One change first, so the feed has an id to resume from.
    await post('send', { message: { sender_id: 'agent:gap', message_id: 'g0', title: 'Before the drop' } });
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'Before the drop'));
    await post('drop-feeds');
    // Changes made while the feed is down arrive after the resume.
    await post('send', { message: { sender_id: 'agent:gap', message_id: 'g1', title: 'Made during the drop' } });
    await until(() => es.opens.length >= 2 && h.store.state.connection === 'connected');
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'Made during the drop'));
    expect(es.opens[1].lastEventId).not.toBeNull();
    const opened = (await fakeState()).feedOpens as { after: number; lastEventId: string | null }[];
    // The Server resumed from Last-Event-ID, the last change the tab applied.
    expect(opened[opened.length - 1].lastEventId).toBe(es.opens[1].lastEventId);
    expect(h.sources).toHaveLength(1);
    h.s.stop();
  });

  it('after a fatal close with an expired cursor (410), reads the whole inbox again and reopens from its rev', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    h.s.messageOpened(h.store.state.messages.get(LISBON)!);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    // The removal is past retention: the tab never sees it as a change.
    await post('expire-cursor', { remove: 'Quarterly report is ready' });
    await until(() => h.sources.length >= 2 && h.store.state.connection === 'connected');
    expect([...h.store.state.messages.values()].some((m) => m.payload.title === 'Quarterly report is ready')).toBe(false);
    expect(h.store.state.messages.size).toBe(5);
    // Held conversations are read again.
    expect(h.store.state.threads.get(LISBON)?.turns.length).toBe(3);
    expect(h.requests.filter((r) => r.url.includes('/v2/inbox')).length).toBeGreaterThanOrEqual(2);
    h.s.stop();
  });

  it('after a fatal close whose cursor still holds, applies the missed changes and reopens', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('fail-feeds', { count: 1 });
    await post('server-shutdown');
    await post('send', { message: { sender_id: 'agent:late', message_id: 'l1', title: 'After the restart' } });
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'After the restart'));
    await until(() => h.store.state.connection === 'connected');
    expect(h.store.state.messages.size).toBe(7);
    expect(h.s.log.list().some((r) => r.closing === 'server_shutdown')).toBe(true);
    h.s.stop();
  });

  it('a sign-in that ends closes the feed (revoked) and the tab leaves for sign-in (401)', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('end-session');
    await until(() => h.ended());
    expect(h.store.state.connection).toBe('ended');
    expect(live(h)).toHaveLength(0);
    expect(h.s.log.list().some((r) => r.closing === 'revoked')).toBe(true);
    expect(h.s.log.list().some((r) => r.status === 401 && r.token === 'unauthorized' && r.requestId)).toBe(true);
    h.s.stop();
  });

  it('a feed that dies with a 401 (EventSource hides it) ends the sign-in after one fetch', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    // Signed out with no closing event: the feed drops and its reconnect gets 401.
    await fetch(`${base()}/__fake/drop-feeds`, { method: 'POST' });
    await post('end-session');
    await until(() => h.ended());
    expect(h.store.state.connection).toBe('ended');
    h.s.stop();
  });

  it('resends an answer after an unknown outcome with the same key, and takes the replayed response as the original', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('hold-answers');
    void h.s.answer(h.store.state.messages.get(SURVEY)!, 'approve', 'Approve', { control: 'approve' });
    await until(() => h.store.state.answers.get(SURVEY)?.state === 'sending');
    // The Server applies it, but the response never arrives.
    await post('release-answers');
    await until(() => h.store.state.messages.get(SURVEY)!.terminal !== null || h.store.state.answers.get(SURVEY)?.state === 'accepted');
    h.s.stop();

    const h2 = session();
    h2.s.start();
    await until(() => h2.store.state.connection === 'connected');
    const lisbon = h2.store.state.messages.get(LISBON)!;
    await post('hold-answers');
    void h2.s.answer(lisbon, 'plaza', 'Lisboa Plaza', { control: 'plaza' });
    await until(() => h2.store.state.answers.get(LISBON)?.state === 'sending');
    await post('drop');
    await until(() => h2.store.state.answers.get(LISBON)?.state === 'failed');
    expect(h2.store.state.answers.get(LISBON)?.reason).toBe('connection');
    await post('hold-answers', { on: false });
    // Resent once, by itself, when the feed is back.
    await until(() => h2.store.state.answers.get(LISBON)?.state === 'accepted');
    const answers = h2.requests.filter((r) => r.url.endsWith('/answer'));
    expect(answers).toHaveLength(2);
    expect(answers[1].key).toBe(answers[0].key);
    // Retry of the same intent after it went through: replayed, nothing applied twice.
    const before = (await fakeState()).answerFrames.length;
    const raw = await fetch(`${base()}/v2/items/${itemId('agent:research', 'lisbon')}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': answers[0].key! },
      body: JSON.stringify({ request_revision: 1, choice: 'plaza' }),
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('idempotent-replayed')).toBe('true');
    expect((await fakeState()).answerFrames.length).toBe(before + 1);
    expect((await fakeState()).lastAnswer.answer).toBe('plaza');
    h2.s.stop();
  });

  it('Retry resends a failed answer with the same key; Edit starts a new one', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('fail-answers');
    void h.s.answer(h.store.state.messages.get(DEPLOY)!, 'Roll back', 'Roll back', { control: 'reply', text: 'Roll back' });
    await until(() => h.store.state.answers.get(DEPLOY)?.state === 'failed');
    expect(h.store.state.answers.get(DEPLOY)?.reason).toBe('storage_unavailable');
    await post('fail-answers', { on: false });
    h.s.retryAnswer(DEPLOY);
    await until(() => h.store.state.answers.get(DEPLOY)?.state === 'accepted');
    const keys = new Set(h.requests.filter((r) => r.url.endsWith('/answer')).map((r) => r.key));
    expect(keys.size).toBe(1);
    expect((await fakeState()).lastAnswer.answer).toBe('Roll back');
    h.s.stop();
  });

  it('sends each answer shape the contract names', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const m = (title: string) => [...h.store.state.messages.values()].find((x) => x.payload.title === title)!;
    await h.s.answer(m('The hosting card expires next month'), null, null, { seen: true, control: 'seen' });
    await h.s.noComment(m('Approve the survey questions?'));
    await h.s.answer(m('Production deploy failed'), 'Hold it', 'Hold it', { control: 'reply', text: 'Hold it' });
    await h.s.answer(m('Which hotel should I book for Lisbon?'), 'avenida', 'Hotel Avenida', { control: 'avenida' });
    const bodies = (await fakeState()).answerFrames.map((f: { body: unknown }) => f.body);
    expect(bodies).toEqual([
      { request_revision: 1, choice: 'seen' },
      { request_revision: 1 },
      { request_revision: 1, comment: 'Hold it' },
      { request_revision: 1, choice: 'avenida' },
    ]);
    for (const title of ['The hosting card expires next month', 'Approve the survey questions?']) expect(m(title).terminal).not.toBeNull();
    expect(m('The hosting card expires next month').terminal?.outcome?.kind).toBe('seen');
    expect(m('Approve the survey questions?').terminal?.state).toBe('no_comment');
    h.s.stop();
  });

  it('a stale request_revision, an answered item and a retraction are refused, shown, and never resent', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const survey = h.store.state.messages.get(SURVEY)!;
    await h.s.answer({ ...survey, revision: 7 }, 'approve', 'Approve', { control: 'approve' });
    expect(h.store.state.answers.get(SURVEY)).toMatchObject({ state: 'refused', reason: 'stale_revision' });
    await post('answer-elsewhere', { title: 'Production deploy failed', text: 'From the phone' });
    await h.s.answer(h.store.state.messages.get(DEPLOY)!, 'retry', 'Retry the release', { control: 'retry' });
    expect(h.store.state.answers.get(DEPLOY)).toMatchObject({ state: 'refused', reason: 'closed' });
    await post('retract', { title: 'Which hotel should I book for Lisbon?' });
    await h.s.answer(h.store.state.messages.get(LISBON)!, 'plaza', 'Lisboa Plaza', { control: 'plaza' });
    expect(h.store.state.answers.get(LISBON)).toMatchObject({ state: 'refused', reason: 'retracted' });
    await until(() => h.store.state.messages.get(LISBON)!.terminal?.retracted === true);
    expect(h.requests.filter((r) => r.url.endsWith('/answer'))).toHaveLength(3);
    expect(h.s.log.list().filter((r) => r.status === 409).map((r) => r.token)).toEqual(['stale_request', 'already_answered', 'already_retracted']);
    h.s.stop();
  });

  it('chat replies go through in every item state: answered, retracted, and agent not listening', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const lisbon = () => h.store.state.messages.get(LISBON)!;
    h.s.messageOpened(lisbon());
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    await h.s.answer(lisbon(), 'plaza', 'Lisboa Plaza', { control: 'plaza' });
    await h.s.chat(lisbon(), 'After answering', []);
    await post('availability', { title: 'Which hotel should I book for Lisbon?', state: 'not_listening' });
    await until(() => lisbon().v2!.availability === 'not_listening');
    await h.s.chat(lisbon(), 'While it is away', []);
    await post('retract', { title: 'Which hotel should I book for Lisbon?' });
    await until(() => lisbon().terminal?.retracted === true);
    await h.s.chat(lisbon(), 'After the retraction', []);
    const texts = h.store.state.threads.get(LISBON)!.turns.map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(['After answering', 'While it is away', 'After the retraction']));
    expect(h.store.state.chatSends).toHaveLength(0);
    h.s.stop();
  });

  it('uploads files with POST /v2/files, then names them on the reply', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const lisbon = h.store.state.messages.get(LISBON)!;
    h.s.messageOpened(lisbon);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    const a = new Blob([new Uint8Array(1000).fill(7)], { type: 'image/png' });
    const b = new Blob([new Uint8Array(300_000).fill(9)]);
    await h.s.chat(lisbon, 'Two files', [
      { id: 'p1', name: 'small.png', size: a.size, file: a },
      { id: 'p2', name: 'large.bin', size: b.size, file: b },
    ]);
    const turn = h.store.state.threads.get(LISBON)!.turns.find((t) => t.text === 'Two files')!;
    expect(turn.files.map((f) => f.size)).toEqual([1000, 300_000]);
    expect(turn.files.every((f) => typeof f.file_id === 'string')).toBe(true);
    const uploads = h.requests.filter((r) => r.url.endsWith('/v2/files'));
    expect(uploads).toHaveLength(2);
    expect(new Set(uploads.map((u) => u.key)).size).toBe(2);
    expect((await fakeState()).v2Uploads.map((u: { contentType: string }) => u.contentType)).toEqual(['image/png', 'application/octet-stream']);
    // The file reads back from GET /v2/files/{id}.
    const got = await fetch(`${base()}${h.s.fileHref(turn.files[0].file_id!)}`);
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBe(1000);
    h.s.stop();
  });

  it('a chat send with no response stays sending and is resent with the same keys once the feed is back', async () => {
    let drop = true;
    const h = session({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (drop && String(input).endsWith('/replies')) {
          drop = false;
          await fetch(input, init); // the Server applies it; the response is lost
          throw new TypeError('network');
        }
        return fetch(input, init);
      }) as typeof fetch,
    });
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const lisbon = h.store.state.messages.get(LISBON)!;
    h.s.messageOpened(lisbon);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    await h.s.chat(lisbon, 'Exactly once', []);
    await until(() => h.store.state.chatSends.length === 0);
    const replies = h.requests.filter((r) => r.url.endsWith('/replies'));
    expect(replies).toHaveLength(2);
    expect(replies[1].key).toBe(replies[0].key);
    expect(h.store.state.threads.get(LISBON)!.turns.filter((t) => t.text === 'Exactly once')).toHaveLength(1);
    h.s.stop();
  });

  it('marks Seen once per revision and moves the read position to the reply on screen', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const lisbon = h.store.state.messages.get(LISBON)!;
    expect(lisbon.v2!.seen).toBe(false);
    h.s.messageOpened(lisbon);
    h.s.messageOpened(lisbon);
    await until(() => h.store.state.messages.get(LISBON)!.v2!.seen);
    expect(h.requests.filter((r) => r.url.endsWith('/seen'))).toHaveLength(1);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    const { hasUnread } = await import('../../../src/state/store');
    expect(hasUnread(h.store.state, LISBON)).toBe(true);
    const last = h.store.state.threads.get(LISBON)!.turns.filter((t) => t.kind === 'reply').at(-1)!;
    h.s.markRead(LISBON, last.seq!);
    await until(() => h.store.state.messages.get(LISBON)!.v2!.readPosition === last.id);
    expect(hasUnread(h.store.state, LISBON)).toBe(false);
    h.s.stop();
  });

  it('pages the inbox on demand', async () => {
    await post('bulk', { count: 25 });
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    expect(h.store.state.messages.size).toBe(20);
    expect(h.store.state.morePages).toBe(true);
    await h.s.loadMore();
    expect(h.store.state.messages.size).toBe(31);
    expect(h.store.state.morePages).toBe(false);
    h.s.stop();
  });

  it('an account that cannot use messaging shows the account notice', async () => {
    await post('inactive');
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'inactive');
    expect(h.sources).toHaveLength(0);
    h.s.stop();
  });

  it('logs Request-Id, status and token, and never message content', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('fail-answers');
    await h.s.answer(h.store.state.messages.get(DEPLOY)!, 'Secret words', 'Secret words', { control: 'reply', text: 'Secret words' });
    const rec = h.s.log.list().filter((r) => r.op === 'answer');
    expect(rec.length).toBeGreaterThan(0);
    expect(rec[0]).toMatchObject({ status: 503, token: 'storage_unavailable' });
    expect(rec[0].requestId).toMatch(/^rq_/);
    expect(JSON.stringify(h.s.log.list())).not.toContain('Secret');
    h.s.stop();
  });
});
