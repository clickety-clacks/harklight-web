// Which rows show in each tab, and in what order. With the Server's view held
// the list follows its list_items in Server order, with chat reply rows,
// free-order section headings and thread groups, as the iPhone app draws it.
// Without a view it falls back to open messages first, newest first.

import { belongsToReplied, fyiSeen, isFyi, senderLabel, type Priority } from './message';
import type { State } from './store';
import type { HeldMessage } from './types';
import { keyOf } from './types';
import type { FreeSection, ListItem } from './view';

export type Tab = 'inbox' | 'replied';

export interface MessageRow {
  type: 'message';
  key: string;
  message: HeldMessage;
  priority: Priority;
  history: boolean;
}

export interface ReplyRow {
  type: 'reply';
  /** The parent message's key. */
  key: string;
  message: HeldMessage | undefined;
  conversationSeq: number;
  openAt: number;
  unseen: number;
  priority: Priority;
  historical: boolean;
  history: boolean;
}

export interface Heading {
  type: 'heading';
  title: string;
  note?: string;
}

export interface ThreadGroup {
  type: 'thread';
  id: string;
  label: string;
  members: MessageRow[];
}

export type Entry = MessageRow | ReplyRow | Heading | ThreadGroup;

/** Kept for code that only needs message rows. */
export type Row = MessageRow;

/** Only a confirmed answer moves a message: while sending, or after a failed
 * send, its row stays where it is and shows that state. */
function localAnswered(s: State, key: string): boolean {
  const a = s.answers.get(key);
  return !!a && !a.seen && a.state === 'accepted';
}

export function inReplied(s: State, key: string): boolean {
  const m = s.messages.get(key);
  if (!m) return false;
  return belongsToReplied(m, localAnswered(s, key));
}

/**
 * The FYI list that holds this message: Replied's once marked Seen, Inbox's
 * while it waits for that. Null for one that is not an FYI, or that ended or
 * was answered some other way, which is an ordinary row.
 */
export function fyiTab(s: State, key: string): Tab | null {
  const m = s.messages.get(key);
  if (!m || !visible(m) || !isFyi(m.payload)) return null;
  if (fyiSeen(m)) return 'replied';
  return m.terminal || inReplied(s, key) ? null : 'inbox';
}

/** Whether a message is on a tab: in its list, its FYI list, or a chat reply row there. */
export function onTab(s: State, key: string, tab: Tab, groupFyi: boolean): boolean {
  if (groupFyi && fyiTab(s, key) === tab) return true;
  return entries(s, tab, groupFyi).some((e) =>
    e.type === 'thread' ? e.members.some((m) => m.key === key) : e.type !== 'heading' && e.key === key,
  );
}

/** A newer revision replaces a superseded one; everything else stays listed, retracted messages included. */
function visible(m: HeldMessage): boolean {
  return m.terminal?.state !== 'superseded';
}

function rowDetails(s: State) {
  const priority = new Map<string, Priority>();
  const thread = new Map<string, string | null>();
  for (const e of s.view?.entries ?? []) {
    if (!priority.has(e.key)) {
      priority.set(e.key, e.priority);
      thread.set(e.key, e.thread);
    }
  }
  return { priority, thread };
}

/** Every row of a tab, flattened: the messages the detail can step through. */
export function rows(s: State, tab: Tab, groupFyi = false): MessageRow[] {
  const out: MessageRow[] = [];
  for (const e of entries(s, tab, groupFyi)) {
    if (e.type === 'message') out.push(e);
    if (e.type === 'thread') out.push(...e.members);
  }
  return out;
}

export function entries(s: State, tab: Tab, groupFyi = false): Entry[] {
  const items = s.view?.listItems;
  return items ? fromListItems(s, tab, items, s.view!.freeOrder && tab === 'inbox', groupFyi) : fallback(s, tab, groupFyi);
}

function messageRow(s: State, key: string, m: HeldMessage, sc: ReturnType<typeof rowDetails>, history: boolean): MessageRow {
  const open = m.terminal === null && !inReplied(s, key);
  const mark = sc.priority.get(key) ?? null;
  return { type: 'message', key, message: m, priority: open ? mark : null, history };
}

function fromListItems(s: State, tab: Tab, items: ListItem[], freeOrder: boolean, groupFyi: boolean): Entry[] {
  const sc = rowDetails(s);
  const { thread } = sc;
  const flat: (MessageRow | ReplyRow | Heading)[] = [];
  const headed = new Set<string>();
  let lastSection: FreeSection | null = null;
  const heading = (title: string, note?: string) => {
    if (headed.has(title)) return;
    headed.add(title);
    flat.push({ type: 'heading', title, note });
  };

  for (const it of items) {
    if (it.kind === 'message') {
      const m = s.messages.get(it.key);
      if (!m || !visible(m) || (groupFyi && fyiTab(s, it.key) !== null)) continue;
      // An FYI answered some other way is in Replied only, History or not.
      if (groupFyi && tab === 'inbox' && isFyi(m.payload) && inReplied(s, it.key)) continue;
      if (!freeOrder && (tab === 'replied') !== inReplied(s, it.key)) continue;
    } else {
      if (it.unseen === null) continue;
      if (!freeOrder && (tab === 'inbox') !== it.unseen > 0) continue;
    }
    if (freeOrder && it.section && (lastSection === null || it.section.state !== lastSection.state || it.section.group !== lastSection.group)) {
      const sec = it.section;
      if (sec.state === 'history') heading('History');
      if (sec.group !== 'common') {
        heading(
          'Earlier activity',
          'Earlier messages and chat replies are grouped separately; their combined arrival order is unavailable.',
        );
      }
      if (sec.group === 'earlier_messages') heading('Earlier messages');
      if (sec.group === 'earlier_chat_replies') heading('Earlier chat replies');
      if (sec.group === 'earlier_chat_replies_unknown') {
        heading('Earlier chat replies');
        heading(
          'Arrival order unavailable',
          'These chat replies have no verified arrival order. Their position here does not mean they are older than the replies above.',
        );
      }
      lastSection = sec;
    }
    const history = it.section?.state === 'history';
    if (it.kind === 'message') {
      flat.push(messageRow(s, it.key, s.messages.get(it.key)!, sc, history));
    } else {
      flat.push({
        type: 'reply',
        key: it.key,
        message: s.messages.get(it.key),
        conversationSeq: it.conversationSeq,
        openAt: it.openAt,
        unseen: it.unseen ?? 0,
        priority: it.priority,
        historical: it.historical,
        history,
      });
    }
  }
  return groupThreads(s, flat, thread);
}

/**
 * Adjacent open Inbox messages from one sender in the same thread collapse
 * into one group, as on the phone. Never inside History.
 */
function groupThreads(s: State, flat: (MessageRow | ReplyRow | Heading)[], thread: Map<string, string | null>): Entry[] {
  const out: Entry[] = [];
  let run: MessageRow[] = [];
  const groupable = (e: MessageRow | ReplyRow | Heading): e is MessageRow =>
    e.type === 'message' &&
    !e.history &&
    e.message.terminal === null &&
    !inReplied(s, e.key) &&
    thread.has(e.key) &&
    !!thread.get(e.key);
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0];
      out.push({
        type: 'thread',
        id: `${first.message.sender_id}\u0000${thread.get(first.key)}`,
        label: `${run.length} messages from ${senderLabel(first.message)}`,
        members: run,
      });
    } else out.push(...run);
    run = [];
  };
  for (const e of flat) {
    if (groupable(e)) {
      const prev = run[run.length - 1];
      if (prev && (prev.message.sender_id !== e.message.sender_id || thread.get(prev.key) !== thread.get(e.key))) flush();
      run.push(e);
    } else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

/** Without a view: open messages first, newest first; finished ones after. */
function fallback(s: State, tab: Tab, groupFyi: boolean): Entry[] {
  const sc = rowDetails(s);
  const out: MessageRow[] = [];
  for (const m of s.messages.values()) {
    const key = keyOf(m);
    if (!visible(m) || (groupFyi && fyiTab(s, key) !== null)) continue;
    if ((tab === 'replied') !== inReplied(s, key)) continue;
    out.push(messageRow(s, key, m, sc, false));
  }
  const rank = new Map<string, number>();
  (s.view?.entries ?? []).forEach((e, i) => rank.has(e.key) || rank.set(e.key, i));
  const isOpen = (r: MessageRow) => r.message.terminal === null && !inReplied(s, r.key);
  out.sort((a, b) => {
    const oa = isOpen(a);
    const ob = isOpen(b);
    if (oa !== ob) return oa ? -1 : 1;
    if (oa) {
      const ra = rank.get(a.key) ?? Infinity;
      const rb = rank.get(b.key) ?? Infinity;
      if (ra !== rb) return ra - rb;
    }
    if (a.message.acceptedSeq !== b.message.acceptedSeq) return b.message.acceptedSeq - a.message.acceptedSeq;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}
