import { describe, expect, it } from 'vitest';
import { entries, rows } from '../../../src/state/inbox';
import { hasUnread, initialState } from '../../../src/state/store';
import { applyEntry, applyItem, applyRemoved, compareCodePoints, keyOfItem, Model, viewOf, wantThread } from '../../../src/v2/model';
import { readChange, readEntry, readInboxPage, readItem, readMe, type Entry, type Item } from '../../../src/v2/wire';

function item(over: Partial<Item> = {}): Item {
  return {
    item_id: 'it_1',
    rev: 1,
    sender: 'agent:a',
    request_revision: 1,
    message: { title: 'Hello', message_type: 'request' },
    files: [],
    seen: false,
    chat: { available: true, started: false, read_position: null, last_origin_reply: null },
    terminal: null,
    rank: { key: 'b' },
    ...over,
  };
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    entry_id: 'en_1',
    item_id: 'it_1',
    rev: 2,
    position: 1,
    kind: 'reply',
    author: 'origin',
    at_ms: 0,
    request_revision: 1,
    text: 'hi',
    ...over,
  };
}

const K = keyOfItem({ sender: 'agent:a', item_id: 'it_1' });

describe('client API v2 model', () => {
  it('applies an item only if its rev is newer than the one held', () => {
    const s = initialState();
    const m = new Model();
    expect(applyItem(s, m, item({ rev: 5, message: { title: 'Five' } }))).toBe(true);
    expect(applyItem(s, m, item({ rev: 3, message: { title: 'Three' } }))).toBe(false);
    expect(applyItem(s, m, item({ rev: 5, message: { title: 'Five again' } }))).toBe(false);
    expect(s.messages.get(K)!.payload.title).toBe('Five');
    expect(applyItem(s, m, item({ rev: 6, message: { title: 'Six' } }))).toBe(true);
    expect(s.messages.get(K)!.payload.title).toBe('Six');
  });

  it('converges whatever order a read, a write response and feed events arrive in', () => {
    const versions = [
      item({ rev: 2, seen: true }),
      item({ rev: 4, seen: true, terminal: { state: 'answered', at_ms: 1 } }),
      item({ rev: 3, seen: true, request_revision: 1 }),
    ];
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [1, 2, 0],
    ];
    for (const order of orders) {
      const s = initialState();
      const m = new Model();
      for (const i of order) applyItem(s, m, versions[i]);
      expect(s.messages.get(K)!.v2!.rev).toBe(4);
      expect(s.messages.get(K)!.terminal?.state).toBe('answered');
    }
  });

  it('keeps a tombstone: an older snapshot row does not bring a removed item back, a newer one does', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ rev: 2 }));
    applyRemoved(s, m, 'it_1', 5);
    expect(s.messages.has(K)).toBe(false);
    expect(applyItem(s, m, item({ rev: 4 }))).toBe(false);
    expect(s.messages.has(K)).toBe(false);
    expect(applyItem(s, m, item({ rev: 6 }))).toBe(true);
    expect(s.messages.has(K)).toBe(true);
  });

  it('a removal older than the held item is ignored', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ rev: 7 }));
    applyRemoved(s, m, 'it_1', 5);
    expect(s.messages.has(K)).toBe(true);
  });

  it('sorts entries by position and upserts them by rev', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item());
    // Entries of a conversation the tab does not hold are dropped.
    expect(applyEntry(s, m, entry())).toBe(false);
    wantThread(s, K);
    applyEntry(s, m, entry({ entry_id: 'en_3', position: 3, rev: 9, text: 'three' }));
    applyEntry(s, m, entry({ entry_id: 'en_1', position: 1, rev: 4, text: 'one' }));
    applyEntry(s, m, entry({ entry_id: 'en_2', position: 2, rev: 6, author: 'person', text: 'two' }));
    expect(s.threads.get(K)!.turns.map((t) => t.text)).toEqual(['one', 'two', 'three']);
    expect(s.threads.get(K)!.turns.map((t) => t.kind)).toEqual(['reply', 'discussion', 'reply']);
    // A newer version (delivered) replaces it in place; an older one does not.
    applyEntry(s, m, entry({ entry_id: 'en_2', position: 2, rev: 10, author: 'person', text: 'two', delivery: { delivered: true } }));
    applyEntry(s, m, entry({ entry_id: 'en_2', position: 2, rev: 5, author: 'person', text: 'stale' }));
    expect(s.threads.get(K)!.turns.map((t) => t.text)).toEqual(['one', 'two', 'three']);
    expect(s.threads.get(K)!.delivered.has('en_2')).toBe(true);
  });

  it('unread chat: the newest origin reply is past the read position', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ chat: { available: true, started: true, last_origin_reply: 'en_3', read_position: 'en_1' } }));
    expect(hasUnread(s, K)).toBe(true);
    applyItem(s, m, item({ rev: 2, chat: { available: true, started: true, last_origin_reply: 'en_3', read_position: 'en_3' } }));
    expect(hasUnread(s, K)).toBe(false);
    applyItem(s, m, item({ rev: 3, chat: { available: true, started: true, last_origin_reply: null, read_position: null } }));
    expect(hasUnread(s, K)).toBe(false);
  });

  it('maps terminal states: retracted stays listed, no comment and Seen are told apart', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ terminal: { state: 'retracted', at_ms: 1 } }));
    expect(s.messages.get(K)!.terminal).toMatchObject({ retracted: true });
    expect(rows(s, 'inbox').map((r) => r.key)).toEqual([K]);
    applyItem(s, m, item({ rev: 2, terminal: { state: 'answered', at_ms: 1, answer: { kind: 'no_comment' } } }));
    expect(s.messages.get(K)!.terminal?.state).toBe('no_comment');
    const seenUi = { schema: 'attention-client.actions/1', actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: { acknowledgment: 'seen' } }] };
    applyItem(s, m, item({ rev: 3, message: { title: 'FYI', answer_ui: seenUi }, terminal: { state: 'answered', at_ms: 1, answer: { kind: 'seen' } } }));
    expect(s.messages.get(K)!.terminal?.outcome?.kind).toBe('seen');
    // A Server that names no answer for a Seen: still the Seen check, in the Inbox.
    applyItem(s, m, item({ rev: 4, message: { title: 'FYI', answer_ui: seenUi }, terminal: { state: 'answered', at_ms: 1 } }));
    expect(s.messages.get(K)!.terminal?.outcome?.kind).toBe('seen');
    expect(rows(s, 'inbox').map((r) => r.key)).toEqual([K]);
    applyItem(s, m, item({ rev: 5, terminal: { state: 'superseded', at_ms: 1 } }));
    expect(rows(s, 'inbox')).toHaveLength(0);
  });

  it('shows the answer from Terminal.answer, given here or on another device', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ terminal: { state: 'answered', at_ms: 1, answer: { kind: 'reply', text: 'Ship it' }, by_this_person: true } }));
    expect(s.messages.get(K)!.terminal).toMatchObject({ state: 'answered', outcome: { kind: 'reply', text: 'Ship it' } });
    applyItem(s, m, item({ rev: 2, terminal: { state: 'answered', at_ms: 1, answer: { kind: 'default', value: { decision: 'revise' } } } }));
    expect(s.messages.get(K)!.terminal?.outcome).toEqual({ kind: 'default', text: undefined, value: { decision: 'revise' } });
    applyItem(s, m, item({ rev: 3, terminal: { state: 'answered', at_ms: 1 } }));
    expect(s.messages.get(K)!.terminal?.outcome).toBeNull();
  });

  it('draws an unread agent reply row just before its item, from Chat.unread_replies', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ item_id: 'it_a', rank: { key: 'a' } }));
    applyItem(s, m, item({ item_id: 'it_b', rank: { key: 'b' }, chat: { available: true, started: true, last_origin_reply: 'en_4', read_position: null, unread_replies: 2 } }));
    const kb = keyOfItem({ sender: 'agent:a', item_id: 'it_b' });
    wantThread(s, kb);
    applyEntry(s, m, entry({ item_id: 'it_b', entry_id: 'en_4', position: 4, text: 'Booked it' }));
    s.view = viewOf(s);
    expect(s.view.listItems!.map((i) => `${i.kind}:${i.key.split('\u0000')[1]}`)).toEqual(['message:it_a', 'reply:it_b', 'message:it_b']);
    const reply = s.view.listItems![1];
    expect(reply.kind === 'reply' && [reply.unseen, reply.conversationSeq]).toEqual([2, 4]);
    expect(hasUnread(s, kb)).toBe(true);
  });

  it('orders the inbox by rank key, by code point', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ item_id: 'it_a', rank: { key: 'b' } }));
    applyItem(s, m, item({ item_id: 'it_b', rank: { key: 'a\u{1F600}' } }));
    applyItem(s, m, item({ item_id: 'it_c', rank: { key: 'a￿' } }));
    s.view = viewOf(s);
    // U+FFFF sorts before U+1F600 by code point (and by UTF-8 bytes), unlike UTF-16 order.
    expect(s.view.listItems!.map((i) => i.key.split('\u0000')[1])).toEqual(['it_c', 'it_b', 'it_a']);
    expect(compareCodePoints('a￿', 'a\u{1F600}')).toBeLessThan(0);
  });
});

describe('client API v2 thread groups', () => {
  const ui = { schema: 'attention-client.actions/1', actions: [{ id: 'ok', label: 'OK', kind: 'value', value: 'ok' }] };
  const open = (id: string, key: string, sender: string, thread?: string) =>
    item({ item_id: id, sender, rank: { key, section: 'current' }, message: { title: id, display_name: 'Agent A', answer_ui: ui }, ...(thread ? { thread } : {}) });

  it('draws adjacent open items with the same sender and Item.thread as one group', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, open('it_1', 'a', 'agent:a', 't'));
    applyItem(s, m, open('it_2', 'b', 'agent:a', 't'));
    applyItem(s, m, open('it_3', 'c', 'agent:a'));
    s.view = viewOf(s);
    const e = entries(s, 'inbox');
    expect(e[0]).toMatchObject({ type: 'thread', label: '2 messages from Agent A' });
    expect(e.map((x) => x.type)).toEqual(['thread', 'message']);
  });

  it('keeps the same thread name from another sender apart, and never groups across a gap', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, open('it_1', 'a', 'agent:a', 't'));
    applyItem(s, m, open('it_2', 'b', 'agent:b', 't'));
    applyItem(s, m, open('it_3', 'c', 'agent:a', 't'));
    s.view = viewOf(s);
    expect(entries(s, 'inbox').map((x) => x.type)).toEqual(['message', 'message', 'message']);
    // Positive control in the same fixture: once the two agent:a items are adjacent, they group.
    applyItem(s, m, { ...open('it_2', 'd', 'agent:b', 't'), rev: 2 });
    s.view = viewOf(s);
    expect(entries(s, 'inbox').map((x) => x.type)).toEqual(['thread', 'message']);
  });
});

describe('client API v2 priority marks and choice answers', () => {
  it('draws the urgent and high marks from Rank.level, else from the score at today\'s thresholds, else none', () => {
    const s = initialState();
    const m = new Model();
    const ui = { schema: 'attention-client.actions/1', actions: [{ id: 'ok', label: 'OK', kind: 'value', value: 'ok' }] };
    const at = (id: string, key: string, level?: 'now' | 'high' | 'normal' | 'low', score?: number) =>
      item({ item_id: id, rank: { key, section: 'current', ...(level ? { level } : {}), ...(score !== undefined ? { score } : {}) }, message: { title: id, answer_ui: ui } });
    applyItem(s, m, at('it_now', 'a', 'now', 0.1));
    applyItem(s, m, at('it_high', 'b', 'high'));
    // A level wins over the score.
    applyItem(s, m, at('it_normal', 'c', 'normal', 0.99));
    // No level (a selected ranking): the score at today's thresholds.
    applyItem(s, m, at('it_score_urgent', 'd', undefined, 0.95));
    applyItem(s, m, at('it_score_high', 'e', undefined, 0.75));
    applyItem(s, m, at('it_score_plain', 'f', undefined, 0.5));
    // Neither (a progress message): no mark.
    applyItem(s, m, at('it_none', 'g'));
    s.view = viewOf(s);
    expect(rows(s, 'inbox').map((r) => [r.key.split('\u0000')[1], r.priority])).toEqual([
      ['it_now', 'urgent'],
      ['it_high', 'high'],
      ['it_normal', null],
      ['it_score_urgent', 'urgent'],
      ['it_score_high', 'high'],
      ['it_score_plain', null],
      ['it_none', null],
    ]);
  });

  it('marks a reply row from Chat.reply_priority.level', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ rank: { key: 'b', section: 'current', level: 'normal' }, chat: { available: true, started: true, last_origin_reply: 'en_4', unread_replies: 1, reply_rank_key: 'a', reply_priority: { level: 'now' } } }));
    s.view = viewOf(s);
    const reply = entries(s, 'inbox').find((e) => e.type === 'reply');
    expect(reply && reply.type === 'reply' && reply.priority).toBe('urgent');
  });

  it('shows the chosen action\'s label on the answered card, from Terminal.answer kind choice', async () => {
    const { answeredText } = await import('../../../src/state/message');
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item({ terminal: { state: 'answered', at_ms: 1, answer: { kind: 'choice', id: 'approve', label: 'Approve' } } }));
    const held = s.messages.get(K)!;
    expect(held.terminal?.outcome).toMatchObject({ kind: 'choice', choice: { id: 'approve', label: 'Approve' } });
    expect(answeredText(held, null)).toBe('Approve');
  });
});

describe('client API v2 readers', () => {
  it('ignores unknown members and drops malformed resources', () => {
    const page = readInboxPage({ rev: 3, items: [{ ...item(), extra: 1 }, { item_id: 'x' }], counts: { unresolved: 1 }, future: true });
    expect(page?.items).toHaveLength(1);
    expect(readItem({ ...item(), rev: 0 })).toBeNull();
    expect(readEntry({ ...entry(), kind: 'mystery' })).toBeNull();
  });

  it('reads a result entry (the origin\'s result fact) and keeps it out of the chat', () => {
    const e = readEntry({ ...entry(), kind: 'result', author: 'origin', text: undefined, result: { status: 'applied', revision: 1 } });
    expect(e?.kind).toBe('result');
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item());
    wantThread(s, K);
    applyEntry(s, m, e!);
    expect(s.threads.get(K)!.turns.map((t) => t.kind)).toEqual(['result']);
  });

  it('reads a feed event by its id and kind, and keeps big numbers exact', () => {
    const c = readChange('item', '12', JSON.stringify(item()).replace('"title":"Hello"', '"title":"Hello","n":18446744073709551617'));
    expect(c?.rev).toBe(12);
    const it = readItem(c!.data)!;
    expect(String((it.message.n as unknown as { text: string }).text)).toBe('18446744073709551617');
    expect(readChange('closing', '', '{}')).toBeNull();
    expect(readChange('item', '', '{}')).toBeNull();
  });

  it('reads GET /v2/me as the contract nests it: limits hold the upload cap, inline budget and answer-screen limits', () => {
    const me = readMe({
      account: { state: 'paused' },
      features: { priority_level_editing: true },
      limits: { upload_cap_bytes_per_file: 'none', inline_decoded_bytes_per_entry: 1000, answer_ui_limits: { inputs: 128 }, retention_days: 30 },
    });
    expect(me).toEqual({ paused: true, uploadCap: null, inlineBudget: 1000, answerUiLimits: { inputs: 128 } });
    // Limits beside `limits` are not the contract's shape.
    expect(readMe({ account: { state: 'active' }, limits: { inline_decoded_bytes_per_entry: 0 }, answer_ui_limits: { inputs: 1 } })?.answerUiLimits).toBeNull();
  });
});
