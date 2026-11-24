// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captionOf } from '../../../src/state/caption';
import { initialState } from '../../../src/state/store';
import type { Availability } from '../../../src/state/types';
import { Chat, type ChatProps } from '../../../src/ui/Chat';
import { applyEntry, applyItem, keyOfItem, Model, wantThread } from '../../../src/v2/model';
import { readEntry, readItem } from '../../../src/v2/wire';

const K = keyOfItem({ sender: 'agent:a', item_id: 'it_1' });

function world() {
  const s = initialState();
  const m = new Model();
  applyItem(s, m, readItem({
    item_id: 'it_1', rev: 1, sender: 'agent:a', request_revision: 1, message: { title: 'T' }, files: [], seen: false,
    chat: { available: true, started: true }, rank: { key: 'a' },
  })!);
  wantThread(s, K);
  const base = { item_id: 'it_1', kind: 'reply', request_revision: 1, text: 'x', state: 'active' };
  return {
    s,
    mine: (rev: number, delivery?: unknown, id = 'en_1', position = 1) =>
      applyEntry(s, m, readEntry({ ...base, entry_id: id, position, rev, author: 'person', ...(delivery === undefined ? {} : { delivery }) })!),
    reply: (rev: number, to: string, over: object = {}) =>
      applyEntry(s, m, readEntry({ ...base, entry_id: 'en_r', position: 9, rev, author: 'origin', in_reply_to: to, ...over })!),
    text: (availability: Availability = 'listening', id = 'en_1') => {
      const turns = s.threads.get(K)!.turns;
      return captionOf(turns.find((t) => t.id === id)!, turns, availability).text;
    },
  };
}

const SERVED = { delivered: true, acted: false };
const NOT = { ...SERVED, outcome: 'not_handed' };

describe('the caption under a chat turn the person sent', () => {
  it.each<[unknown, string]>([
    // Served alone is not evidence, and neither is the Server's acted.
    [SERVED, 'Sending…'],
    [{ delivered: true, acted: true }, 'Sending…'],
    [{ ...SERVED, ack2_expected: true }, 'Sending…'],
    [{ ...SERVED, ack2_expected: true, listener_received: true }, 'Sending…'],
    [{ ...SERVED, listener_received: true }, 'Sending…'],
    [{ acted: true }, 'Sent'],
    [{}, 'Sent'],
    [undefined, 'Sent'],
    // Evidence.
    [{ ...SERVED, agent_seen: true }, 'Delivered'],
    [{ ...SERVED, agent_acted: true }, 'Delivered'],
    [{ ...NOT, agent_seen: true, reason: 'busy' }, 'Delivered'],
    [{ ...NOT, agent_acted: true }, 'Delivered'],
    // Outcomes.
    [{ ...SERVED, outcome: 'handed' }, 'Delivered'],
    [{ outcome: 'handed' }, 'Delivered'],
    [{ ...SERVED, outcome: 'handed', rerouted: true, agent: 'Night desk' }, 'Delivered to Night desk'],
    [{ ...SERVED, outcome: 'handed', rerouted: true }, 'Delivered'],
    [{ ...SERVED, outcome: 'handed', rerouted: true, agent: '' }, 'Delivered'],
    [{ ...SERVED, outcome: 'handed', rerouted: false, agent: 'Night desk' }, 'Delivered'],
    [{ ...SERVED, outcome: 'handed', agent: 'Night desk' }, 'Delivered'],
    [NOT, 'Not delivered'],
    [{ ...NOT, acted: true }, 'Not delivered'],
    [{ ...NOT, reason: '' }, 'Not delivered'],
    [{ ...NOT, reason: ' ' }, 'Not delivered'],
    [{ ...NOT, reason: '**busy** <b>' }, 'Not delivered: **busy** <b>'],
    [{ ...NOT, rerouted: true, agent: 'Night desk' }, 'Not delivered'],
    [{ ...NOT, legacy_caption: true }, 'Not delivered'],
    [{ ...NOT, ack2_expected: false, listener_received: true }, 'Not delivered'],
    // No receipt can come: only a confirmed listener counts.
    [{ ...SERVED, ack2_expected: false }, 'Sending…'],
    [{ ...SERVED, ack2_expected: false, listener_received: true }, 'Delivered'],
    [{ ...SERVED, ack2_expected: false, listener_received: false }, 'Sending…'],
    [{ ...SERVED, ack2_expected: false, legacy_caption: true }, 'Sending…'],
    [{ ack2_expected: false }, 'Sent'],
    // Old history keeps the old caption.
    [{ ...SERVED, legacy_caption: true }, 'Delivered'],
    [{ acted: true, legacy_caption: true }, 'Delivered'],
    [{ legacy_caption: true }, 'Sent'],
    [{ ...SERVED, legacy_caption: false }, 'Sending…'],
    [{ ...SERVED, legacy_caption: true, outcome: 'handed' }, 'Delivered'],
    // Values this client does not know are absent.
    [{ ...SERVED, outcome: 'later' }, 'Sending…'],
    [{ ...SERVED, ack2_expected: 'false', listener_received: true }, 'Sending…'],
    [{ ...SERVED, ack2_expected: null, listener_received: true }, 'Sending…'],
    [{ ...SERVED, agent_seen: 'yes', agent_acted: 1, legacy_caption: 1 }, 'Sending…'],
    [{ ...NOT, reason: 7 }, 'Not delivered'],
    [{ delivered: 'true' }, 'Sent'],
  ])('%j reads %s', (delivery, want) => {
    const w = world();
    w.mine(2, delivery);
    expect(w.text()).toBe(want);
  });

  it.each<[Availability, unknown, string]>([
    [null, {}, 'Sent'],
    ['not_listening', {}, 'Not delivered yet'],
    ['gone', {}, 'No one will get this'],
    ['unsupported', {}, 'No one will get this'],
    ['not_listening', SERVED, 'Sending…'],
    ['gone', SERVED, 'No one will get this'],
    ['unsupported', SERVED, 'No one will get this'],
    ['gone', { ...SERVED, ack2_expected: true }, 'No one will get this'],
    ['gone', { ...SERVED, ack2_expected: false }, 'No one will get this'],
    ['gone', { ...SERVED, ack2_expected: false, listener_received: true }, 'Delivered'],
    ['gone', { ...SERVED, agent_seen: true }, 'Delivered'],
    ['unsupported', { ...SERVED, agent_acted: true }, 'Delivered'],
    ['unsupported', { ...SERVED, outcome: 'handed' }, 'Delivered'],
    ['not_listening', NOT, 'Not delivered'],
    ['gone', NOT, 'No one will get this'],
    ['unsupported', NOT, 'No one will get this'],
    ['gone', { outcome: 'handed' }, 'Delivered'],
    ['gone', { ...SERVED, legacy_caption: true }, 'Delivered'],
  ])('with the agent %s, %j reads %s', (availability, delivery, want) => {
    const w = world();
    w.mine(2, delivery);
    expect(w.text(availability)).toBe(want);
  });

  it('a reply to the turn wins over not_handed, whichever arrives first, until it is withdrawn', () => {
    for (const first of ['turn', 'reply']) {
      const w = world();
      if (first === 'turn') w.mine(2, NOT);
      w.reply(3, 'en_1');
      if (first === 'reply') w.mine(2, NOT);
      expect(w.text()).toBe('Delivered');
      w.reply(5, 'en_1', { state: 'withdrawn' });
      expect(w.text()).toBe('Not delivered');
      w.reply(4, 'en_1');
      expect(w.text()).toBe('Not delivered');
    }
    const w = world();
    w.mine(2, SERVED);
    w.reply(3, 'en_1', { state: 'retracted' });
    expect(w.text()).toBe('Sending…');
  });

  it('a reply to the turn wins over a conversation that is gone', () => {
    const w = world();
    w.mine(2, SERVED);
    w.reply(3, 'en_1');
    expect([w.text('gone'), w.text('unsupported')]).toEqual(['Delivered', 'Delivered']);
  });

  it('a reply to another turn, or by someone else, is not evidence', () => {
    const w = world();
    w.mine(2, SERVED);
    w.mine(3, SERVED, 'en_2', 2);
    w.reply(4, 'en_2');
    expect([w.text(), w.text('listening', 'en_2')]).toEqual(['Sending…', 'Delivered']);
    w.reply(5, 'en_1', { author: 'person' });
    expect(w.text()).toBe('Sending…');
    w.reply(6, 'en_1', { author: 'server' });
    expect(w.text()).toBe('Sending…');
  });

  it('follows the newest rev; a stale one changes nothing', () => {
    const w = world();
    const HANDED = { ...SERVED, outcome: 'handed' };
    for (const [rev, delivery, want] of [
      [2, SERVED, 'Sending…'], [4, NOT, 'Not delivered'], [3, SERVED, 'Not delivered'], [6, HANDED, 'Delivered'],
      [5, NOT, 'Delivered'], [6, NOT, 'Delivered'], [8, NOT, 'Not delivered'], [9, { ...SERVED, legacy_caption: true }, 'Delivered'],
      [10, undefined, 'Sent'],
    ] as const) {
      w.mine(rev, delivery);
      expect(w.text()).toBe(want);
    }
  });

  describe('drawn', () => {
    afterEach(() => vi.useRealTimers());
    const draw = (w: ReturnType<typeof world>) => {
      const el = document.createElement('div');
      const props: ChatProps = {
        message: w.s.messages.get(K)!, sender: 'A', thread: w.s.threads.get(K), sends: [], open: true, available: true, attachments: false,
        uploadCap: null, canSend: true, paused: false, onClose() {}, column: true, draft: { text: '', files: [] }, onDraft() {},
        onSend() {}, onRetry() {}, onReplyVisible() {}, fileHref: () => '',
      };
      render(<Chat {...props} />, el);
      return el;
    };
    it.each<[unknown]>([[{ ...SERVED, ack2_expected: true }], [SERVED]])('%j still reads Sending however long passes', (delivery) => {
      vi.useFakeTimers();
      const w = world();
      w.mine(2, delivery);
      const el = draw(w);
      expect(el.querySelector('.turn-st')!.textContent).toBe('Sending…');
      vi.advanceTimersByTime(30 * 24 * 3600_000);
      expect(el.querySelector('.turn-st')!.textContent).toBe('Sending…');
      expect(draw(w).querySelector('.turn-st')!.textContent).toBe('Sending…');
    });
    it('shows the reason as plain text', () => {
      const w = world();
      w.mine(2, { ...NOT, reason: '<a href="x">see</a> **this**' });
      const st = draw(w).querySelector('.turn-st')!;
      expect(st.textContent).toBe('Not delivered: <a href="x">see</a> **this**');
      expect(st.querySelector('a')).toBeNull();
    });
  });
});
