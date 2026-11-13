// Which messages show in each tab, and in what order.

import { belongsToReplied, priorityOf, type Priority } from './message';
import type { State } from './store';
import type { HeldMessage } from './types';
import { keyOf } from './types';

export type Tab = 'inbox' | 'replied';

export interface Row {
  key: string;
  message: HeldMessage;
  priority: Priority;
}

const RETRACTED_VISIBLE_MS = 24 * 60 * 60 * 1000;

function localAnswered(s: State, key: string): boolean {
  const a = s.answers.get(key);
  return !!a && !a.seen && (a.state === 'sending' || a.state === 'accepted' || a.state === 'unconfirmed');
}

export function inReplied(s: State, key: string): boolean {
  const m = s.messages.get(key);
  if (!m) return false;
  return belongsToReplied(m, localAnswered(s, key));
}

/**
 * Rows for one tab. Superseded messages are hidden. Open messages come first,
 * in the Server's priority order when a view is held, then newest first;
 * finished ones follow, newest first.
 */
export function rows(s: State, tab: Tab, now = Date.now()): Row[] {
  const rank = new Map<string, number>();
  const score = new Map<string, number | null>();
  s.view?.forEach((e, i) => {
    if (!rank.has(e.key)) {
      rank.set(e.key, i);
      score.set(e.key, e.score);
    }
  });
  const out: Row[] = [];
  for (const m of s.messages.values()) {
    const key = keyOf(m);
    if (m.terminal?.state === 'superseded') continue;
    if (m.terminal?.retracted) {
      const at = typeof m.payload.retracted_at === 'number' ? m.payload.retracted_at : null;
      if (at !== null && now - at > RETRACTED_VISIBLE_MS) continue;
    }
    const replied = inReplied(s, key);
    if ((tab === 'replied') !== replied) continue;
    const open = m.terminal === null && !replied;
    out.push({ key, message: m, priority: open ? priorityOf(score.get(key) ?? null) : null });
  }
  const isOpen = (r: Row) => r.message.terminal === null && !inReplied(s, r.key);
  out.sort((a, b) => {
    const oa = isOpen(a);
    const ob = isOpen(b);
    if (oa !== ob) return oa ? -1 : 1;
    if (oa) {
      const ra = rank.get(a.key);
      const rb = rank.get(b.key);
      if (ra !== undefined || rb !== undefined) {
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        if (ra !== rb) return ra - rb;
      }
    }
    if (a.message.acceptedSeq !== b.message.acceptedSeq) return b.message.acceptedSeq - a.message.acceptedSeq;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}
