import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { chatOpen } from '../../../src/state/store';
import type { HeldMessage, Terminal, V2Item } from '../../../src/state/types';
import { Chat, type ChatProps } from '../../../src/ui/Chat';
import { V2Session } from '../../../src/v2/session';
import { DEFAULT_CONFIG } from '../../../src/config';
import { Store } from '../../../src/state/store';

function v2(over: Partial<V2Item> = {}): V2Item {
  return {
    item_id: 'it_1',
    rev: 1,
    rankKey: 'a',
    score: null,
    seen: true,
    readPosition: null,
    lastOriginReply: null,
    availability: 'listening',
    as: null,
    unreadReplies: null,
    section: null,
    group: null,
    replyGroup: null,
    replyRankKey: null,
    thread: null,
    level: null,
    replyScore: null,
    replyLevel: null,
    ...over,
  };
}

function msg(terminal: Terminal | null, item: Partial<V2Item> = {}, chat = true): HeldMessage {
  return { sender_id: 'agent:a', message_id: 'it_1', payload: {}, revision: 1, acceptedSeq: 1, terminal, files: [], firstFiles: [], chat, v2: v2(item) };
}

function mount(message: HeldMessage, over: Partial<ChatProps> = {}) {
  const el = document.createElement('div');
  document.body.append(el);
  const props: ChatProps = {
    message,
    sender: 'Agent',
    thread: undefined,
    sends: [],
    open: chatOpen(undefined, message),
    available: true,
    attachments: false,
    uploadCap: null,
    canSend: true,
    paused: false,
    onClose: () => {},
    column: false,
    draft: { text: '', files: [] },
    onDraft: () => {},
    onSend: () => {},
    onRetry: () => {},
    onReplyVisible: () => {},
    fileHref: (id) => id,
    ...over,
  };
  render(<Chat {...props} />, el);
  return el;
}

const STATES: [string, HeldMessage][] = [
  ['open', msg(null)],
  ['answered', msg({ state: 'answered', seq: 2, retracted: false, outcome: null })],
  ['no comment', msg({ state: 'no_comment', seq: 2, retracted: false, outcome: { kind: 'no_comment' } })],
  ['expired', msg({ state: 'expired', seq: 2, retracted: false, outcome: null })],
  ['retracted but listed', msg({ state: 'cleared', seq: 2, retracted: true, outcome: null })],
  ['agent not listening', msg(null, { availability: 'not_listening' })],
];

describe('client API v2 chat composer', () => {
  for (const [name, m] of STATES) {
    it(`stays enabled when the item is ${name}`, () => {
      expect(chatOpen(undefined, m)).toBe(true);
      const el = mount(m);
      const field = el.querySelector<HTMLTextAreaElement>('textarea')!;
      expect(field).not.toBeNull();
      expect(field.disabled).toBe(false);
      expect(el.textContent).not.toContain('This chat is closed');
      expect(el.textContent).not.toContain('did not open a chat');
    });
  }

  it('has no composer when the item has no conversation (Chat.available false)', () => {
    const m = msg(null, { availability: null }, false);
    expect(chatOpen(undefined, m)).toBe(false);
    const el = mount(m);
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.textContent).toContain('did not open a chat');
  });

  it('says a reply refused as unsupported was not possible, with no Retry', () => {
    const m = msg(null);
    const el = mount(m, { sends: [{ op_id: 'o1', key: 'agent:a\u0000it_1', revision: 1, text: 'Hi', files: [], state: 'closed', reason: 'unsupported' }] });
    expect(el.textContent).toContain('Not sent. This message has no chat.');
    expect(el.textContent).not.toContain('Retry');
  });

  it('tells the person when the agent is not listening, without blocking', () => {
    const el = mount(msg(null, { availability: 'not_listening' }));
    expect(el.querySelector('[data-testid=chat-away]')?.textContent).toContain("isn't listening right now");
    expect(el.querySelector('textarea')).not.toBeNull();
    expect(mount(msg(null)).querySelector('[data-testid=chat-away]')).toBeNull();
  });

  it('can write while the feed reconnects, but not once the sign-in ended or the account is paused', () => {
    const s = new V2Session({ config: DEFAULT_CONFIG, store: new Store(), fetch, eventSource: () => { throw new Error('unused'); }, onSessionEnded: () => {} });
    expect(s.canWrite({ connection: 'reconnecting', loaded: true })).toBe(true);
    expect(s.canWrite({ connection: 'connected', loaded: true })).toBe(true);
    expect(s.canWrite({ connection: 'connecting', loaded: false })).toBe(false);
    expect(s.canWrite({ connection: 'ended', loaded: true })).toBe(false);
    expect(s.canWrite({ connection: 'inactive', loaded: true })).toBe(false);
  });

});

import { answerForm, answeredText } from '../../../src/state/message';

describe('client API v2 answers: a plain written answer is always offered', () => {
  const actions = (list: unknown[]) => ({ message_type: 'request', answer_ui: { schema: 'attention-client.actions/1', actions: list } });
  it('adds Reply to choices that have none, and leaves one that has it', () => {
    const f = answerForm(actions([{ id: 'ok', label: 'OK', kind: 'value', value: 'ok' }]) as never);
    expect(f.kind === 'choices' && f.choices.map((c) => `${c.kind}:${c.id}`)).toEqual(['value:ok', 'text:reply']);
    const g = answerForm(actions([{ id: 'reply', label: 'Write', kind: 'text' }]) as never);
    expect(g.kind === 'choices' && g.choices).toHaveLength(1);
    const h = answerForm(actions([{ id: 'reply', label: 'Yes', kind: 'value', value: 1 }]) as never);
    expect(h.kind === 'choices' && h.choices.map((c) => c.id)).toEqual(['reply', '_reply']);
  });
  it('turns a screen this client cannot draw into a plain reply with a note', () => {
    const f = answerForm({ message_type: 'request', answer_ui: { schema: 'something.else/9' } } as never);
    expect(f).toMatchObject({ kind: 'choices', notShown: true });
    expect(f.kind === 'choices' && f.choices.map((c) => c.kind)).toEqual(['text']);
  });
  it('never offers a written answer on an information message (Seen)', () => {
    const f = answerForm(actions([{ id: 'seen', label: 'Seen', kind: 'value', value: { acknowledgment: 'seen' } }]) as never);
    expect(f.kind).toBe('seen');
  });
});

describe('client API v2 answered card: the kind alone decides', () => {
  const ui1 = { schema: 'attention-client.ui/1' };
  const answered = (outcome: Terminal['outcome'], payload: Record<string, unknown> = {}) =>
    ({ ...msg({ state: 'answered', seq: 2, retracted: false, outcome }), payload } as HeldMessage);
  it('shows reply text, the choice label, and nothing for Seen or no comment', () => {
    expect(answeredText(answered({ kind: 'reply', text: 'approve' }, { answer_ui: { schema: 'attention-client.actions/1', actions: [{ id: 'a', label: 'Approve', kind: 'value', value: 'approve' }] } }), null)).toBe('approve');
    expect(answeredText(answered({ kind: 'choice', choice: { id: 'a', label: 'Approve' } }), null)).toBe('Approve');
    expect(answeredText(answered({ kind: 'seen' }), 'x')).toBeNull();
    expect(answeredText(answered({ kind: 'no_comment' }), 'x')).toBeNull();
  });
  it('renders a result of any JSON type, including null, 0, false and empty string', () => {
    for (const [value, text] of [[null, 'null'], [0, '0'], [false, 'false'], ['', ''], [{ cover: 'B' }, '{"cover":"B"}'], [[1, 2], '[1,2]']] as const) {
      expect(answeredText(answered({ kind: 'result', value: value as never }, { answer_ui: ui1 }), null)).toBe(text);
    }
    // This tab's own answer shows its form summary.
    expect(answeredText(answered({ kind: 'result', value: { cover: 'B' } }, { answer_ui: ui1 }), 'Use cover B')).toBe('Use cover B');
  });
});
