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

function session(opts: { fetch?: typeof fetch; livenessMs?: number } = {}): Harness {
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
    livenessMs: opts.livenessMs,
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
    const lisbon = h.store.state.messages.get(LISBON)!;
    await post('hold-answers');
    void h.s.answer(lisbon, 'plaza', 'Lisboa Plaza', { control: 'plaza' });
    await until(() => h.store.state.answers.get(LISBON)?.state === 'sending');
    // The connection drops with the answer in flight: the outcome is unknown.
    await post('drop');
    await until(() => h.store.state.answers.get(LISBON)?.state === 'failed');
    expect(h.store.state.answers.get(LISBON)?.reason).toBe('connection');
    // The resend (once the feed is back) waits at the Server behind the first.
    await until(() => h.requests.filter((r) => r.url.endsWith('/answer')).length === 2);
    // The Server applies the first; the resend gets the stored response, replayed.
    await post('release-answers');
    await until(() => h.store.state.answers.get(LISBON)?.state === 'accepted');
    const answers = h.requests.filter((r) => r.url.endsWith('/answer'));
    expect(answers[1].key).toBe(answers[0].key);
    const st = await fakeState();
    expect(st.replays).toBe(1);
    expect(st.lastAnswer.answer).toBe('plaza');
    expect(h.store.state.messages.get(LISBON)!.terminal?.state).toBe('answered');
    h.s.stop();
  });

  it('an unread reply row reads only the newest page of its conversation; opening the item reads it whole', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await until(() => h.requests.some((r) => r.url.includes(`${itemId('agent:research', 'lisbon')}/entries`)));
    await new Promise((r) => setTimeout(r, 100));
    const reads = () => h.requests.filter((r) => r.url.includes(`${itemId('agent:research', 'lisbon')}/entries`)).length;
    expect(reads()).toBe(1);
    // Another batch of changes does not read it again.
    await post('send', { message: { sender_id: 'agent:x', message_id: 'x1', title: 'Another' } });
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'Another'));
    expect(reads()).toBe(1);
    h.s.messageOpened(h.store.state.messages.get(LISBON)!);
    await until(() => reads() === 2);
    h.s.stop();
  });

  it('a paused tab notices when the pause is lifted and carries on', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('inactive');
    await until(() => h.store.state.connection === 'inactive');
    await post('send', { message: { sender_id: 'agent:p', message_id: 'p1', title: 'Sent during the pause' } });
    await post('active');
    await until(() => h.store.state.connection === 'connected');
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'Sent during the pause'));
    h.s.stop();
  });

  it('an item removed and brought back reads its conversation again', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    h.s.messageOpened(h.store.state.messages.get(LISBON)!);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    await post('remove', { title: 'Which hotel should I book for Lisbon?' });
    await until(() => !h.store.state.messages.has(LISBON));
    await post('restore');
    await until(() => h.store.state.messages.has(LISBON));
    h.s.messageOpened(h.store.state.messages.get(LISBON)!);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    h.s.stop();
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
    // Each upload names its file (Content-Disposition filename*).
    expect(turn.files.map((f) => f.name)).toEqual(['small.png', 'large.bin']);
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

  it('a chat send with no response is settled by its turn on the feed, or resent with the same key, never doubled', async () => {
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
    // Either the feed brought the turn first (it settles the send, nothing is
    // resent) or the resend went first, with the same key (replayed).
    const replies = h.requests.filter((r) => r.url.endsWith('/replies'));
    expect(replies.length).toBeLessThanOrEqual(2);
    expect(new Set(replies.map((r) => r.key)).size).toBe(1);
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

  it('a paused account keeps what the tab holds readable and stops sending (403 account_paused)', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('inactive');
    await until(() => h.store.state.connection === 'inactive');
    expect(h.store.state.messages.size).toBe(6);
    expect(live(h)).toHaveLength(0);
    expect(h.s.log.list().some((r) => r.closing === 'account_paused')).toBe(true);
    expect(h.s.canWrite(h.store.state)).toBe(false);
    h.s.stop();
  });

  it('a feed silent past the liveness window is reopened from the cursor; heartbeats keep it alive', async () => {
    await post('heartbeat', { ms: 50 });
    const h = session({ livenessMs: 400 });
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await new Promise((r) => setTimeout(r, 700));
    expect(h.sources).toHaveLength(1);
    await post('mute-feeds');
    await until(() => h.sources.length === 2 && h.store.state.connection === 'connected');
    expect(h.sources[0].readyState).toBe(2);
    expect(h.s.log.list().some((r) => r.closing === 'silent')).toBe(true);
    await post('send', { message: { sender_id: 'agent:after', message_id: 'a1', title: 'After the silence' } });
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'After the silence'));
    h.s.stop();
  });

  it('shows an answer given on another device from Terminal.answer', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('answer-elsewhere', { title: 'Production deploy failed', text: 'From the phone' });
    await until(() => h.store.state.messages.get(DEPLOY)!.terminal !== null);
    expect(h.store.state.messages.get(DEPLOY)!.terminal?.outcome).toMatchObject({ kind: 'reply', text: 'From the phone' });
    h.s.stop();
  });

  it('draws unread agent replies as inbox rows, with their text', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    const row = () => h.store.state.view?.listItems?.find((i) => i.kind === 'reply' && i.key === LISBON);
    await until(() => !!row() && (row() as { conversationSeq: number }).conversationSeq > 0);
    const seq = (row() as { conversationSeq: number }).conversationSeq;
    expect(h.store.state.threads.get(LISBON)!.turns.find((t) => t.seq === seq)?.text).toBe('Yes. Every room has a desk and wired internet.');
    h.s.stop();
  });

  it('draws today\'s sections: free order with finished items under History, and reads file limits from /v2/me', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected' && h.store.state.fileLimits !== null);
    const { WEB_LIMITS } = await import('../../../src/ui1/validate');
    // The answer-screen limits come from GET /v2/me answer_ui_limits too.
    expect(h.store.state.fileLimits).toEqual({ inline: 262_144, cap: 20_000_000, ui1: WEB_LIMITS });
    const { entries } = await import('../../../src/state/inbox');
    expect(h.store.state.view!.freeOrder).toBe(true);
    const list = entries(h.store.state, 'inbox');
    const history = list.findIndex((e) => e.type === 'heading' && e.title === 'History');
    expect(history).toBeGreaterThan(0);
    const after = list.slice(history + 1).filter((e) => e.type === 'message').map((e) => String((e as { message: { payload: Record<string, unknown> } }).message.payload.title));
    expect(after).toContain('Your week ahead');
    h.s.stop();
  });

  it('Try again after a failure resumes from the cursor: a change to a held conversation made meanwhile is not lost', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    h.s.messageOpened(h.store.state.messages.get(LISBON)!);
    await until(() => (h.store.state.threads.get(LISBON)?.turns.length ?? 0) === 3);
    await post('refuse-reads');
    await until(() => h.store.state.connection === 'failed');
    await post('reply', { sender_id: 'agent:research', message_id: 'lisbon', text: 'Sent while the tab had failed' });
    await post('refuse-reads', { on: false });
    h.s.tryAgain();
    await until(() => h.store.state.connection === 'connected');
    await until(() => h.store.state.threads.get(LISBON)!.turns.some((t) => t.text === 'Sent while the tab had failed'));
    h.s.stop();
  });

  it('a 502 with no contract body (a proxy while the Server restarts) is retried, not a failure', async () => {
    const h = session();
    h.s.start();
    await until(() => h.store.state.connection === 'connected');
    await post('bad-gateway');
    await until(() => h.s.log.list().some((r) => r.status === 502));
    await new Promise((r) => setTimeout(r, 200));
    expect(h.store.state.connection).toBe('reconnecting');
    await post('send', { message: { sender_id: 'agent:back', message_id: 'b1', title: 'After the restart' } });
    await post('bad-gateway', { on: false });
    await until(() => [...h.store.state.messages.values()].some((m) => m.payload.title === 'After the restart'));
    expect(h.store.state.connection).toBe('connected');
    h.s.stop();
  });

  it('the same text from another device never takes the place of this tab\'s pending send', async () => {
    let releaseMine: (() => void) | null = null;
    const h = session({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/replies') && !releaseMine && (init?.headers as Record<string, string>)['x-other'] === undefined) {
          // This tab's first send: held, then lost with no response.
          await new Promise<void>((r) => (releaseMine = r));
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
    void h.s.chat(lisbon, 'ok', []);
    await until(() => releaseMine !== null);
    // Another device sends the same text.
    await fetch(`${base()}/v2/items/${itemId('agent:research', 'lisbon')}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ text: 'ok' }),
    });
    await until(() => h.store.state.threads.get(LISBON)!.turns.filter((t) => t.text === 'ok').length === 1);
    // This tab's request is lost; it must still be resent, not dropped.
    releaseMine!();
    await until(() => h.store.state.threads.get(LISBON)!.turns.filter((t) => t.text === 'ok').length === 2);
    expect(h.store.state.chatSends).toHaveLength(0);
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
