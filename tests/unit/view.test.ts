import { describe, expect, it } from 'vitest';
import { entries } from '../../src/state/inbox';
import { messageType } from '../../src/state/message';
import { initialState } from '../../src/state/store';
import { applyEntry, applyItem, Model, viewOf, wantThread } from '../../src/v2/model';
import type { Item } from '../../src/v2/wire';

function item(id: string, rank: Item['rank'], over: Partial<Item> = {}): Item {
  return {
    item_id: id,
    rev: 1,
    sender: 'agent:a',
    request_revision: 1,
    message: { title: id, display_name: 'Agent A', message_type: 'request' },
    files: [],
    seen: false,
    chat: { available: true, started: false },
    terminal: null,
    rank,
    ...over,
  };
}

const label = (x: ReturnType<typeof entries>[number]) =>
  x.type === 'heading' ? `#${x.title}` : x.type === 'thread' ? 'thread' : `${x.type}:${x.key.split('\u0000')[1]}`;

describe('inbox from the items’ rank', () => {
  it('follows rank order, with an unread reply row and History for resolved items', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item('m2', { key: 'a', section: 'current', group: 'common' }));
    applyItem(s, m, item('m1', { key: 'c', section: 'current', group: 'common' }, {
      chat: { available: true, started: true, last_origin_reply: 'en_5', unread_replies: 2, reply_rank_key: 'b' },
    }));
    applyItem(s, m, item('m3', { key: 'd', section: 'resolved' }, { terminal: { state: 'answered', at_ms: 1, answer: { kind: 'reply', text: 'x' } } }));
    s.view = viewOf(s);
    expect(entries(s, 'inbox').map(label)).toEqual(['message:m2', 'reply:m1', 'message:m1', '#History', 'message:m3']);
  });

  it('sorts the full projection by known posting times and keeps Priority order for ties and unknowns', () => {
    const s = initialState();
    const model = new Model();
    const rank = (key: string) => ({ key, section: 'current' as const, group: 'common' as const });
    applyItem(s, model, item('older', rank('a'), { created_at_ms: 20, thread: 'one' }));
    applyItem(s, model, item('newer', rank('b'), { created_at_ms: 30, thread: 'one' }));
    applyItem(s, model, item('tie', rank('c'), { message: { title: 'tie', created_at: 30 } }));
    applyItem(s, model, item('unknown', rank('d'), {
      chat: { available: true, started: true, last_origin_reply: 'reply-1', unread_replies: 1, reply_rank_key: 'e' },
    }));
    applyItem(s, model, item('history', { key: 'f', section: 'resolved' }, {
      created_at_ms: 40, terminal: { state: 'answered', at_ms: 90 },
    }));
    wantThread(s, model.keyFor('unknown')!);
    applyEntry(s, model, { entry_id: 'reply-1', item_id: 'unknown', rev: 1, position: 1,
      kind: 'reply', author: 'origin', request_revision: 1, at_ms: 50 });
    s.view = viewOf(s);
    expect(entries(s, 'inbox').map(label)).toEqual(['thread', 'message:tie', 'message:unknown',
      'reply:unknown', '#History', 'message:history']);
    expect(entries(s, 'inbox', false, 'posted').map(label)).toEqual(['reply:unknown', 'message:history',
      'message:newer', 'message:tie', 'message:older', 'message:unknown']);
  });

  it('without free order there are no headings, and the tabs split by membership', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item('m1', { key: 'a', section: 'current' }));
    applyItem(s, m, item('m2', { key: 'b', section: 'resolved' }, { terminal: { state: 'answered', at_ms: 1, answer: { kind: 'reply', text: 'x' } } }));
    s.view = viewOf(s);
    expect(s.view.freeOrder).toBe(false);
    expect(entries(s, 'inbox').map(label)).toEqual(['message:m1']);
    expect(entries(s, 'replied').map(label)).toEqual(['message:m2']);
  });

  it('turns free order off when the Server’s sections go backwards', () => {
    const s = initialState();
    const m = new Model();
    applyItem(s, m, item('m1', { key: 'a', section: 'resolved' }));
    applyItem(s, m, item('m2', { key: 'b', section: 'current', group: 'common' }));
    s.view = viewOf(s);
    expect(s.view.freeOrder).toBe(false);
  });
});

describe('type colours, shared with the app', () => {
  it('keeps a successful request violet and applies kinds to legacy messages after their base type', () => {
    const seen = { schema: 'attention-client.actions/1', actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: { acknowledgment: 'seen' } }] };
    expect(messageType({ message_type: 'request', message_kind: 'success' })).toBe('request');
    expect(messageType({ answer_ui: seen, message_kind: 'blocker' })).toBe('warn');
    expect(messageType({ title: 'legacy', message_kind: 'blocker' })).toBe('error');
    expect(messageType({ answer_ui: seen, message_kind: 'success' })).toBe('done');
  });
});
