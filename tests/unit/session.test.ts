// @vitest-environment node
// The relay session against the local fake of the browser contract.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error the fake server is plain JavaScript
import { startFakeServer } from '../../dev/fake-server.mjs';
import { DEFAULT_CONFIG } from '../../src/config';
import { RelaySession } from '../../src/relay/session';
import type { SocketLike } from '../../src/relay/connection';
import { Store } from '../../src/state/store';
import { keyOf } from '../../src/state/types';
import { fetchFileLimits } from '../../src/relay/files';
import { WEB_LIMITS } from '../../src/ui1/validate';

let server: { port: number; close: () => Promise<void> };
const base = () => `http://127.0.0.1:${server.port}`;
const post = (path: string, body: unknown = {}) =>
  fetch(`${base()}/__fake/${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => (fn() ? resolve() : Date.now() > end ? reject(new Error('timed out')) : setTimeout(tick, 10));
    tick();
  });
}

function session(store: Store, onEnd: () => void = () => undefined, setTimer: (fn: () => void, ms: number) => unknown = (fn) => setTimeout(fn, 0)) {
  return new RelaySession({
    config: DEFAULT_CONFIG,
    store,
    socketFactory: (url) => new WebSocket(url, { origin: base() }) as unknown as SocketLike,
    location: { protocol: 'http:', host: `127.0.0.1:${server.port}` },
    setTimer,
    onSessionEnded: onEnd,
  });
}

const LISBON = keyOf({ sender_id: 'agent:research', message_id: 'lisbon' });

beforeEach(async () => {
  server = await startFakeServer({ port: 0, vite: false, dist: 'dist', flags: [] });
});
afterEach(async () => {
  await server.close();
});

describe('relay session', () => {
  it('loads the inbox, its chats and the priority view', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    expect(store.state.messages.size).toBe(6);
    expect(store.state.threads.get(LISBON)?.turns.length).toBe(3);
    expect(store.state.view?.entries.length).toBeGreaterThan(0);
    expect(store.state.view?.listItems?.length).toBeGreaterThan(0);
    s.stop();
  });

  it('receives a new message live', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    await post('send', { message: { sender_id: 'agent:new', message_id: 'n1', title: 'Fresh' } });
    await until(() => store.state.messages.has(keyOf({ sender_id: 'agent:new', message_id: 'n1' })));
    s.stop();
  });

  it('answers with the choice value and Seen with JSON null', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    const lisbon = store.state.messages.get(LISBON)!;
    await s.answer(lisbon, 'plaza', 'Lisboa Plaza');
    expect(store.state.answers.get(LISBON)?.state).toBe('accepted');
    expect((await fetch(`${base()}/__fake/state`).then((r) => r.json())).lastAnswer.answer).toBe('plaza');
    await until(() => store.state.messages.get(LISBON)?.terminal?.state === 'answered');

    const quarterly = store.state.messages.get(keyOf({ sender_id: 'agent:build', message_id: 'quarterly' }))!;
    await s.answer(quarterly, null, null, { seen: true, control: 'seen' });
    expect((await fetch(`${base()}/__fake/state`).then((r) => r.json())).lastAnswer.answer).toBe(null);
    s.stop();
  });

  it('sends No comment as the three-key frame', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    const survey = keyOf({ sender_id: 'agent:research', message_id: 'survey' });
    await s.noComment(store.state.messages.get(survey)!);
    expect(store.state.answers.get(survey)?.state).toBe('accepted');
    await until(() => store.state.messages.get(survey)?.terminal?.state === 'no_comment');
    s.stop();
  });

  it('sends chat and shows the agent reply', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    await s.chat(store.state.messages.get(LISBON)!, 'Is breakfast included?', []);
    await until(() => store.state.threads.get(LISBON)!.turns.some((t) => t.text === 'Is breakfast included?'));
    expect(store.state.chatSends).toEqual([]);
    await post('reply', { sender_id: 'agent:research', message_id: 'lisbon', text: 'Yes, until 10.' });
    await until(() => store.state.threads.get(LISBON)!.turns.some((t) => t.text === 'Yes, until 10.'));
    s.stop();
  });

  it('resumes after a dropped connection without losing events', async () => {
    const store = new Store();
    let retry: (() => void) | null = null;
    const s = session(store, undefined, (fn) => (retry = fn));
    s.start();
    await until(() => store.state.connection === 'connected');
    await post('drop');
    await until(() => store.state.connection === 'reconnecting' && retry !== null);
    await post('send', { message: { sender_id: 'agent:new', message_id: 'gap', title: 'While away' } });
    retry!();
    await until(() => store.state.connection === 'connected');
    await until(() => store.state.messages.has(keyOf({ sender_id: 'agent:new', message_id: 'gap' })));
    expect(store.state.threads.get(LISBON)?.turns.length).toBe(3);
    s.stop();
  });

  it('resends an answer that failed only because the connection dropped, once, with its original op_id', async () => {
    const store = new Store();
    let retry: (() => void) | null = null;
    const s = session(store, undefined, (fn) => (retry = fn));
    s.start();
    await until(() => store.state.connection === 'connected');
    await post('hold-answers');
    const lisbon = store.state.messages.get(LISBON)!;
    void s.answer(lisbon, 'plaza', 'Lisboa Plaza');
    await until(() => store.state.answers.get(LISBON)?.state === 'sending');
    await post('drop');
    await until(() => store.state.answers.get(LISBON)?.state === 'failed' && retry !== null);
    expect(store.state.answers.get(LISBON)?.reason).toBe('connection');
    await post('hold-answers', { on: false });
    retry!();
    await until(() => store.state.answers.get(LISBON)?.state === 'accepted');
    const frames = (await fetch(`${base()}/__fake/state`).then((r) => r.json())).answerFrames;
    expect(frames).toHaveLength(2);
    expect(frames[1].op_id).toBe(frames[0].op_id);
    s.stop();
  });

  it('resends a connection-failed answer only once; a second failure waits for Retry', async () => {
    const store = new Store();
    let retry: (() => void) | null = null;
    const s = session(store, undefined, (fn) => (retry = fn));
    s.start();
    await until(() => store.state.connection === 'connected');
    await post('hold-answers');
    void s.answer(store.state.messages.get(LISBON)!, 'plaza', 'Lisboa Plaza');
    await until(() => store.state.answers.get(LISBON)?.state === 'sending');
    await post('drop');
    await until(() => store.state.answers.get(LISBON)?.state === 'failed' && retry !== null);
    // The automatic resend is held, then the connection drops again.
    const first = retry!;
    retry = null;
    first();
    await until(() => store.state.connection === 'connected');
    await until(() => store.state.answers.get(LISBON)?.state === 'sending');
    await post('drop');
    await until(() => store.state.answers.get(LISBON)?.state === 'failed' && retry !== null);
    await post('hold-answers', { on: false });
    retry!();
    await until(() => store.state.connection === 'connected');
    await new Promise((r) => setTimeout(r, 200));
    expect(store.state.answers.get(LISBON)?.state).toBe('failed');
    const frames = (await fetch(`${base()}/__fake/state`).then((r) => r.json())).answerFrames;
    expect(frames).toHaveLength(2);
    s.retryAnswer(LISBON);
    await until(() => store.state.answers.get(LISBON)?.state === 'accepted');
    s.stop();
  });

  it('tryAgain starts a new attempt after a policy close', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    await post('policy-close');
    await until(() => store.state.connection === 'failed');
    s.tryAgain();
    await until(() => store.state.connection === 'connected');
    expect(store.state.messages.has(LISBON)).toBe(true);
    s.stop();
  });

  it('an answer in flight at a policy close is resent once by Try again, with its original op_id', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    await post('hold-answers');
    void s.answer(store.state.messages.get(LISBON)!, 'plaza', 'Lisboa Plaza');
    await until(() => store.state.answers.get(LISBON)?.state === 'sending');
    await post('policy-close');
    await until(() => store.state.connection === 'failed');
    expect(store.state.answers.get(LISBON)).toMatchObject({ state: 'failed', reason: 'connection' });
    await post('hold-answers', { on: false });
    s.tryAgain();
    await until(() => store.state.answers.get(LISBON)?.state === 'accepted');
    const frames = (await fetch(`${base()}/__fake/state`).then((r) => r.json())).answerFrames;
    expect(frames).toHaveLength(2);
    expect(frames[1].op_id).toBe(frames[0].op_id);
    s.stop();
  });

  it('starts over on a new recipient when a resume is refused, since the old one cannot start again', async () => {
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    const first = s.recipient;
    await post('forget-snapshots');
    await post('drop');
    await until(() => store.state.connection === 'connected' && s.recipient !== first, 5000);
    expect(store.state.messages.has(LISBON)).toBe(true);
    s.stop();
  });

  it('gives each client start its own recipient', async () => {
    const a = session(new Store());
    const b = session(new Store());
    expect(a.recipient).not.toBe(b.recipient);
  });

  it('leaves for sign-in on 4401 and stops on 4403', async () => {
    const store = new Store();
    let ended = false;
    const s = session(store, () => {
      ended = true;
    });
    s.start();
    await until(() => store.state.connection === 'connected');
    await post('end-session');
    await until(() => ended);
    expect(store.state.connection).toBe('ended');

    await post('reset');
    const store2 = new Store();
    const s2 = session(store2);
    s2.start();
    await until(() => store2.state.connection === 'connected');
    await post('inactive');
    await until(() => store2.state.connection === 'inactive');
  });
});

describe('file limits', () => {
  it('carry the custom-screen bounds the Server publishes', async () => {
    const limits = await fetchFileLimits({ base: '/browser/v1', fetch: (path, init) => fetch(`${base()}${String(path)}`, init) }, '00000000-0000-4000-8000-000000000000');
    expect(limits.ui1).toEqual(WEB_LIMITS);
    expect(typeof limits.inline).toBe('number');
  });
});

describe('view catch-up', () => {
  it('pages in every message the view lists as soon as the connection is ready, without scrolling', async () => {
    // 25 newer requests fill the first page; older listed requests sit on page two.
    await post('bulk', { count: 25 });
    const store = new Store();
    const s = session(store);
    s.start();
    await until(() => store.state.connection === 'connected');
    await until(() => {
      const items = store.state.view?.listItems ?? [];
      return items.length > 0 && items.every((it) => store.state.messages.has(it.key));
    });
    expect(store.state.messages.has(LISBON)).toBe(true);
    s.stop();
  });
});
