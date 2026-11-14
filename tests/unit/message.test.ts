import { describe, expect, it } from 'vitest';
import { answerForm, answeredText, belongsToReplied, initials, messageType, priorityOf, senderLabel } from '../../src/state/message';
import type { HeldMessage, JsonObject } from '../../src/state/types';

const seen = {
  schema: 'attention-client.actions/1',
  actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: { acknowledgment: 'seen' } }],
};

function held(payload: JsonObject, terminal: HeldMessage['terminal'] = null): HeldMessage {
  return { sender_id: 'agent:x', message_id: 'm', payload, revision: 1, acceptedSeq: 1, terminal, files: [], firstFiles: [], chat: true };
}

describe('message type', () => {
  it('maps message_type and message_kind to the five design types', () => {
    expect(messageType({ message_type: 'request' })).toBe('request');
    expect(messageType({ message_type: 'request', message_kind: 'blocker' })).toBe('error');
    expect(messageType({ message_type: 'fyi', answer_ui: seen })).toBe('info');
    expect(messageType({ message_type: 'fyi', message_kind: 'success', answer_ui: seen })).toBe('done');
    expect(messageType({ message_type: 'fyi', message_kind: 'blocker', answer_ui: seen })).toBe('warn');
  });
  it('reads an untyped message by its answer form', () => {
    expect(messageType({ answer_ui: seen })).toBe('info');
    expect(messageType({ title: 'x' })).toBe('request');
  });
});

describe('answer form', () => {
  it('recognises the Seen descriptor', () => {
    expect(answerForm({ answer_ui: seen }).kind).toBe('seen');
  });
  it('offers a text reply when the message has no answer controls', () => {
    const f = answerForm({ title: 't' });
    expect(f).toEqual({ kind: 'choices', choices: [{ id: 'reply', label: 'Reply', kind: 'text', suggested: false }] });
  });
  it('keeps value and text actions in order and marks the default as suggested', () => {
    const f = answerForm({
      default: { value: 'b', at: 1 },
      answer_ui: {
        schema: 'attention-client.actions/1',
        actions: [
          { id: 'a', label: 'A', kind: 'value', value: 'a' },
          { id: 'b', label: 'B', kind: 'value', value: 'b' },
          { id: 'r', label: 'Reply', kind: 'text' },
        ],
      },
    });
    expect(f.kind).toBe('choices');
    if (f.kind !== 'choices') return;
    expect(f.choices.map((c) => [c.id, c.kind, c.suggested])).toEqual([
      ['a', 'value', false],
      ['b', 'value', true],
      ['r', 'text', false],
    ]);
  });
  it('treats other answer formats as unsupported', () => {
    expect(answerForm({ answer_ui: { schema: 'attention-client.ui/1' } }).kind).toBe('unsupported');
  });
});

describe('tabs', () => {
  it('moves answered and No comment messages to Replied and keeps Seen in the Inbox', () => {
    expect(belongsToReplied(held({}), false)).toBe(false);
    expect(belongsToReplied(held({}), true)).toBe(true);
    expect(belongsToReplied(held({}, { state: 'answered', seq: 2, retracted: false, outcome: { kind: 'reply', text: 'x' } }), false)).toBe(true);
    expect(belongsToReplied(held({}, { state: 'no_comment', seq: 2, retracted: false, outcome: null }), false)).toBe(true);
    expect(belongsToReplied(held({}, { state: 'answered', seq: 2, retracted: false, outcome: { kind: 'seen' } }), false)).toBe(false);
    expect(belongsToReplied(held({}, { state: 'expired', seq: 2, retracted: false, outcome: null }), false)).toBe(false);
  });
});

describe('labels', () => {
  it('uses the display name, else the short sender id', () => {
    expect(senderLabel({ sender_id: 'agent:research', payload: { display_name: 'Research agent' } })).toBe('Research agent');
    expect(senderLabel({ sender_id: 'app:team/deploy', payload: {} })).toBe('deploy');
    expect(initials('Research agent')).toBe('RA');
  });
  it('takes priority from the view score', () => {
    expect(priorityOf(0.95)).toBe('urgent');
    expect(priorityOf(0.75)).toBe('high');
    expect(priorityOf(0.5)).toBe(null);
    expect(priorityOf(null)).toBe(null);
  });
  it('shows the Server outcome text on the answered card, else this tab’s choice', () => {
    const reply = held({}, { state: 'answered', seq: 2, retracted: false, outcome: { kind: 'reply', text: 'Book it' } });
    expect(answeredText(reply, 'ignored')).toBe('Book it');
    const bare = held({}, { state: 'answered', seq: 2, retracted: false, outcome: null });
    expect(answeredText(bare, 'Approve')).toBe('Approve');
    expect(answeredText(bare, null)).toBe(null);
  });
});

import { applyPreview, DEFAULT_CONFIG } from '../../src/config';

describe('web client flag', () => {
  function mem() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  }
  it('is off by default and turns on only in a browser that asked for the preview', () => {
    expect(DEFAULT_CONFIG.flags.webClient).toBe(false);
    const st = mem();
    expect(applyPreview(DEFAULT_CONFIG, '', st).flags.webClient).toBe(false);
    expect(applyPreview(DEFAULT_CONFIG, '#preview', st).flags.webClient).toBe(true);
    expect(applyPreview(DEFAULT_CONFIG, '', st).flags.webClient).toBe(true);
    expect(applyPreview(DEFAULT_CONFIG, '#preview-off', st).flags.webClient).toBe(false);
  });
  it('turns every feature on in the previewing browser, leaving the deployment settings alone', () => {
    const st = mem();
    const live = { ...DEFAULT_CONFIG, flags: { webClient: true, answerForms: true, attachments: false } };
    expect(applyPreview(live, '', st).flags.attachments).toBe(false);
    expect(applyPreview(live, '#preview', st).flags).toEqual({ webClient: true, answerForms: true, attachments: true });
    expect(live.flags.attachments).toBe(false);
  });
});
