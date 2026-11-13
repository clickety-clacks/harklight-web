import { describe, expect, it } from 'vitest';
import {
  applyConversation,
  applyDelivery,
  applyLifecycle,
  applyReadPositions,
  chatOpen,
  hasUnread,
  initialState,
  takePendingTerminal,
} from '../../src/state/store';
import { rows } from '../../src/state/inbox';
import { keyOf } from '../../src/state/types';

const K = keyOf({ sender_id: 'agent:a', message_id: 'm1' });

function delivered(extra: Record<string, unknown> = {}) {
  const s = initialState();
  applyDelivery(s, {
    type: 'delivery',
    seq: 3,
    sender_id: 'agent:a',
    message_id: 'm1',
    session_handle: 'h',
    request_revision: 1,
    message: { sender_id: 'agent:a', message_id: 'm1', title: 'Hello', created_at: 1 },
    ...extra,
  });
  return s;
}

describe('inbox events', () => {
  it('holds a delivered message with its chat handle', () => {
    const s = delivered();
    expect(s.messages.get(K)?.chat).toBe(true);
    expect(rows(s, 'inbox').map((r) => r.key)).toEqual([K]);
  });
  it('applies a lifecycle and treats No comment as its own state', () => {
    const s = delivered();
    applyLifecycle(s, { type: 'lifecycle', seq: 4, sender_id: 'agent:a', message_id: 'm1', state: 'answered', terminal_kind: 'no_comment' });
    expect(s.messages.get(K)?.terminal?.state).toBe('no_comment');
    expect(rows(s, 'replied').map((r) => r.key)).toEqual([K]);
  });
  it('keeps a lifecycle for a message not yet held until it arrives', () => {
    const s = initialState();
    applyLifecycle(s, { type: 'lifecycle', seq: 9, sender_id: 'agent:a', message_id: 'm1', state: 'expired' });
    applyDelivery(s, { seq: 3, sender_id: 'agent:a', message_id: 'm1', message: { title: 'x' } });
    takePendingTerminal(s, K);
    expect(s.messages.get(K)?.terminal?.state).toBe('expired');
  });
  it('marks a retraction', () => {
    const s = delivered();
    applyLifecycle(s, { seq: 5, sender_id: 'agent:a', message_id: 'm1', state: 'cleared', terminal_reason: 'retracted', retracted_at: 10 });
    expect(s.messages.get(K)?.terminal?.retracted).toBe(true);
  });
  it('hides superseded messages', () => {
    const s = delivered();
    applyLifecycle(s, { seq: 5, sender_id: 'agent:a', message_id: 'm1', state: 'superseded' });
    expect(rows(s, 'inbox')).toEqual([]);
    expect(rows(s, 'replied')).toEqual([]);
  });
});

describe('chat', () => {
  it('is open only while the message has a chat and no terminal state', () => {
    const s = delivered();
    expect(chatOpen(undefined, s.messages.get(K))).toBe(true);
    applyLifecycle(s, { seq: 4, sender_id: 'agent:a', message_id: 'm1', state: 'answered', answer_outcome: { kind: 'reply', text: 'ok' } });
    expect(chatOpen(undefined, s.messages.get(K))).toBe(false);
    const noChat = initialState();
    applyDelivery(noChat, { seq: 1, sender_id: 'agent:a', message_id: 'm1', message: { title: 'x' } });
    expect(chatOpen(undefined, noChat.messages.get(K))).toBe(false);
  });
  it('builds turns, marks delivery and ignores a replayed event', () => {
    const s = delivered();
    const base = { type: 'conversation', sender_id: 'agent:a', message_id: 'm1', request_revision: 1 };
    applyConversation(s, { ...base, conversation_seq: 1, kind: 'discussion', author: 'person', text: 'Hi', event_id: 'e1', op_id: 'o1' });
    applyConversation(s, { ...base, conversation_seq: 2, kind: 'reply', author: 'origin', text: 'Hello', event_id: 'e2', in_reply_to: 'e1' });
    applyConversation(s, { ...base, conversation_seq: 2, kind: 'reply', author: 'origin', text: 'Hello', event_id: 'e2', in_reply_to: 'e1' });
    const t = s.threads.get(K)!;
    expect(t.turns.map((x) => x.text)).toEqual(['Hi', 'Hello']);
    expect(t.delivered.has('e1')).toBe(true);
  });
  it('tracks unread agent replies against the account read position', () => {
    const s = delivered();
    applyReadPositions(s, []);
    applyConversation(s, { sender_id: 'agent:a', message_id: 'm1', conversation_seq: 5, kind: 'reply', author: 'origin', text: 'x', event_id: 'e5' });
    expect(hasUnread(s, K)).toBe(true);
    applyConversation(s, { sender_id: 'agent:a', message_id: 'm1', conversation_seq: 6, kind: 'read_position', read_through_conversation_seq: 5 });
    expect(hasUnread(s, K)).toBe(false);
  });
  it('takes a revision’s content and number', () => {
    const s = delivered();
    applyConversation(s, {
      sender_id: 'agent:a',
      message_id: 'm1',
      conversation_seq: 7,
      kind: 'revision',
      request_revision: 2,
      message: { title: 'Hello again' },
    });
    expect(s.messages.get(K)?.revision).toBe(2);
    expect(s.messages.get(K)?.payload.title).toBe('Hello again');
  });
});
