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
  const mem = new Map<string, string>();
  return new RelaySession({
    config: DEFAULT_CONFIG,
    store,
    socketFactory: (url) => new WebSocket(url, { origin: base() }) as unknown as SocketLike,
    storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) },
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
    expect(store.state.view?.length).toBeGreaterThan(0);
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
    await s.answer(quarterly, null, null, true);
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
