import { describe, expect, it } from 'vitest';
import { entries } from '../../src/state/inbox';
import { applyDelivery, applyLifecycle, initialState } from '../../src/state/store';
import { parseView } from '../../src/state/view';
import { messageType } from '../../src/state/message';

function held(ids: string[]) {
  const s = initialState();
  ids.forEach((id, i) =>
    applyDelivery(s, { seq: i + 1, sender_id: 'agent:a', message_id: id, message: { title: id, display_name: 'Agent A' } }),
  );
  return s;
}

describe('inbox from the Server view', () => {
  it('follows list_items in Server order, with reply rows and History', () => {
    const s = held(['m1', 'm2', 'm3']);
    applyLifecycle(s, { seq: 9, sender_id: 'agent:a', message_id: 'm3', state: 'answered', answer_outcome: { kind: 'reply', text: 'x' } });
    s.view = parseView({
      entries: [],
      free_order_version: 1,
      list_items: [
        { kind: 'message', sender_id: 'agent:a', message_id: 'm2', free_section: { state: 'active', group: 'common' } },
        { kind: 'reply', sender_id: 'agent:a', message_id: 'm1', conversation_seq: 5, open_at_conversation_seq: 4, unseen_count: 2, free_section: { state: 'active', group: 'common' } },
        { kind: 'message', sender_id: 'agent:a', message_id: 'm1', free_section: { state: 'active', group: 'common' } },
        { kind: 'message', sender_id: 'agent:a', message_id: 'm3', free_section: { state: 'history', group: 'common' } },
      ],
    });
    const e = entries(s, 'inbox');
    expect(e.map((x) => (x.type === 'heading' ? `#${x.title}` : x.type === 'thread' ? 'thread' : `${x.type}:${x.key.split('\u0000')[1]}`))).toEqual([
      'message:m2',
      'reply:m1',
      'message:m1',
      '#History',
      'message:m3',
    ]);
    // Replied shows only its own rows.
    expect(entries(s, 'replied').map((x) => x.type)).toEqual(['message']);
  });
  it('turns free order off when sections go backwards, and then splits tabs by membership', () => {
    const s = held(['m1', 'm2']);
    s.view = parseView({
      free_order_version: 1,
      list_items: [
        { kind: 'message', sender_id: 'agent:a', message_id: 'm1', free_section: { state: 'history', group: 'common' } },
        { kind: 'message', sender_id: 'agent:a', message_id: 'm2', free_section: { state: 'active', group: 'common' } },
        { kind: 'reply', sender_id: 'agent:a', message_id: 'm2', conversation_seq: 3, open_at_conversation_seq: 3, unseen_count: 0 },
      ],
    });
    expect(s.view.freeOrder).toBe(false);
    expect(entries(s, 'inbox').map((x) => x.type)).toEqual(['message', 'message']);
    expect(entries(s, 'replied').map((x) => x.type)).toEqual(['reply']);
  });
  it('groups adjacent open messages of one sender’s thread', () => {
    const s = held(['m1', 'm2', 'm3']);
    s.view = parseView({
      entries: [
        { sender_id: 'agent:a', message_id: 'm1', thread: 't' },
        { sender_id: 'agent:a', message_id: 'm2', thread: 't' },
      ],
      list_items: ['m1', 'm2', 'm3'].map((id) => ({ kind: 'message', sender_id: 'agent:a', message_id: id })),
    });
    const e = entries(s, 'inbox');
    expect(e[0]).toMatchObject({ type: 'thread', label: '2 messages from Agent A' });
    expect(e[1]).toMatchObject({ type: 'message' });
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
