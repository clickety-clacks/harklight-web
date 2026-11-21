// The Server's priority view (view_get): the order and grouping the inbox is
// drawn in, as the iPhone app draws it (contract D-1, as amended).

import { RawNumber } from '../relay/json';
import { keyOf } from './types';

export interface ViewEntry {
  key: string;
  score: number | null;
  thread: string | null;
  /** Client API v2: the mark the Server's level gives (Rank.level), which wins over the score. */
  priority?: 'urgent' | 'high' | null;
}

export type FreeState = 'active' | 'history';
export type FreeGroup = 'common' | 'earlier_messages' | 'earlier_chat_replies' | 'earlier_chat_replies_unknown';

export interface FreeSection {
  state: FreeState;
  group: FreeGroup;
}

export type ListItem =
  | { kind: 'message'; key: string; section: FreeSection | null }
  | {
      kind: 'reply';
      key: string;
      section: FreeSection | null;
      conversationSeq: number;
      openAt: number;
      unseen: number | null;
      score: number | null;
      historical: boolean;
      /** Client API v2: the mark from Chat.reply_priority.level, which wins over the score. */
      priority?: 'urgent' | 'high' | null;
    };

export interface ServerView {
  entries: ViewEntry[];
  /** Null when the Server sent no list_items. */
  listItems: ListItem[] | null;
  /** Free order is on: every item has a valid section, in order. */
  freeOrder: boolean;
}

const STATES: FreeState[] = ['active', 'history'];
const GROUPS: FreeGroup[] = ['common', 'earlier_messages', 'earlier_chat_replies', 'earlier_chat_replies_unknown'];

function n(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof RawNumber) {
    const x = Number(v.text);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

function section(v: unknown): FreeSection | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!STATES.includes(o.state as FreeState) || !GROUPS.includes(o.group as FreeGroup)) return null;
  return { state: o.state as FreeState, group: o.group as FreeGroup };
}

export function parseView(r: Record<string, unknown>): ServerView {
  const entries: ViewEntry[] = [];
  for (const e of Array.isArray(r.entries) ? (r.entries as Record<string, unknown>[]) : []) {
    if (!e || typeof e.sender_id !== 'string' || typeof e.message_id !== 'string') continue;
    entries.push({
      key: keyOf({ sender_id: e.sender_id, message_id: e.message_id }),
      score: n(e.score),
      thread: typeof e.thread === 'string' ? e.thread : null,
    });
  }
  let listItems: ListItem[] | null = null;
  if (Array.isArray(r.list_items)) {
    listItems = [];
    for (const it of r.list_items as Record<string, unknown>[]) {
      if (!it || typeof it.sender_id !== 'string' || typeof it.message_id !== 'string') continue;
      const key = keyOf({ sender_id: it.sender_id, message_id: it.message_id });
      if (it.kind === 'message') listItems.push({ kind: 'message', key, section: section(it.free_section) });
      else if (it.kind === 'reply') {
        const seq = n(it.conversation_seq);
        if (seq === null) continue;
        listItems.push({
          kind: 'reply',
          key,
          section: section(it.free_section),
          conversationSeq: seq,
          openAt: n(it.open_at_conversation_seq) ?? seq,
          unseen: n(it.unseen_count),
          score: n(it.score),
          historical: it.score_kind === 'historical',
        });
      }
    }
  }
  return { entries, listItems, freeOrder: listItems !== null && freeOrderValid(n(r.free_order_version), listItems) };
}

/** Free order applies only when every item has a section, sections never go
 * backwards, and each group holds its own kind of item. */
export function freeOrderValid(version: number | null, items: ListItem[]): boolean {
  if (version !== 1) return false;
  let last = -1;
  for (const it of items) {
    if (!it.section) return false;
    const pos = STATES.indexOf(it.section.state) * 10 + GROUPS.indexOf(it.section.group);
    if (pos < last) return false;
    last = pos;
    const g = it.section.group;
    if (g === 'earlier_messages' && it.kind !== 'message') return false;
    if ((g === 'earlier_chat_replies' || g === 'earlier_chat_replies_unknown') && it.kind !== 'reply') return false;
  }
  return true;
}
