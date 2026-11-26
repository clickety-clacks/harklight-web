// Applying client API v2 resources to the tab's store. One rule makes every
// order of reads, writes and feed events converge: a resource is applied only
// if its `rev` is newer than the one held (spec section 1). Removed items
// leave a tombstone, gated the same way.
//
// A message key is the item's sender plus its item_id.

import { priorityOf } from '../state/message';
import type { State } from '../state/store';
import type { AnswerOutcome, HeldMessage, Terminal as HeldTerminal, Thread, Turn, WireFile } from '../state/types';
import { keyOf, splitKey } from '../state/types';
import { freeOrderValid, type FreeSection, type ListItem, type ServerView } from '../state/view';
import type { Entry, FileRef, Item, Terminal } from './wire';

/** Bookkeeping the store does not draw: tombstones and which threads are wanted. */
export class Model {
  personId: string | null = null;
  /** item_id -> rev of its removal. */
  readonly tombstones = new Map<string, number>();
  /** item_id -> message key, for entries and removals, which carry only the item_id. */
  readonly keys = new Map<string, string>();

  keyFor(itemId: string): string | undefined {
    return this.keys.get(itemId);
  }
}

export function keyOfItem(item: Pick<Item, 'sender' | 'item_id'>): string {
  return keyOf({ sender_id: item.sender, message_id: item.item_id });
}

/** The item_id inside a message key. */
export function itemIdOf(key: string): string {
  return splitKey(key).message_id;
}

export function toWireFile(f: FileRef): WireFile {
  return { name: f.name, size: f.size, sha256: f.sha256, file_id: f.file_id, ...(f.content_type ? { content_type: f.content_type } : {}) };
}

/** Today's terminal state from the item's. The answer is Terminal.answer, as the person sees it. */
function terminalOf(t: Terminal | null | undefined, rev: number): HeldTerminal | null {
  if (!t) return null;
  if (t.state === 'retracted') return { state: 'cleared', seq: rev, retracted: true, outcome: null };
  const outcome: AnswerOutcome | null = t.answer
    ? {
        kind: t.answer.kind,
        text: t.answer.text,
        value: t.answer.value,
        ...(t.answer.kind === 'choice' && t.answer.id !== undefined ? { choice: { id: t.answer.id, label: t.answer.label ?? t.answer.id } } : {}),
      }
    : null;
  if (t.state !== 'answered') return { state: t.state, seq: rev, retracted: false, outcome };
  return {
    state: outcome?.kind === 'no_comment' ? 'no_comment' : 'answered',
    seq: rev, retracted: false, outcome,
    ...(t.speaker && t.answer_id ? { speaker: t.speaker, answerId: t.answer_id } : {}),
  };
}

function toHeld(item: Item, personId: string | null): HeldMessage {
  const files = item.files.map(toWireFile);
  return {
    sender_id: item.sender,
    message_id: item.item_id,
    payload: item.message,
    revision: item.request_revision,
    // Arrival order, newest highest, where the store sorts by it.
    acceptedSeq: item.created_at_ms ?? item.rev,
    terminal: terminalOf(item.terminal, item.rev),
    files,
    // Item.files holds every file the current answer screen names, so
    // custom forms are checked against it alone.
    firstFiles: files,
    chat: item.chat.available,
    v2: {
      item_id: item.item_id,
      ...(item.shared ? { shared: { ...item.shared, members: item.shared.members.filter((member) => member.person.id !== personId) } } : {}),
      rev: item.rev,
      rankKey: item.rank.key,
      createdAt: item.created_at_ms,
      score: item.rank.score ?? null,
      seen: item.seen,
      readPosition: item.chat.read_position ?? null,
      lastOriginReply: item.chat.last_origin_reply ?? null,
      availability: item.availability?.state ?? null,
      as: item.as ?? null,
      unreadReplies: item.chat.unread_replies ?? null,
      section: item.rank.section ?? null,
      group: item.rank.group ?? null,
      replyGroup: item.chat.reply_group ?? null,
      replyRankKey: item.chat.reply_rank_key ?? null,
      thread: item.thread ?? null,
      level: item.rank.level ?? null,
      replyScore: item.chat.reply_priority?.score ?? null,
      replyLevel: item.chat.reply_priority?.level ?? null,
    },
  };
}

/** Apply one Item. Returns true when it was newer than what the tab held. */
export function applyItem(s: State, model: Model, item: Item): boolean {
  const tomb = model.tombstones.get(item.item_id);
  if (tomb !== undefined) {
    if (item.rev <= tomb) return false;
    model.tombstones.delete(item.item_id);
  }
  const key = keyOfItem(item);
  const prev = s.messages.get(key);
  if (prev?.v2 && prev.v2.rev >= item.rev) return false;
  model.keys.set(item.item_id, key);
  const thread = s.threads.get(key);
  const held = toHeld(item, model.personId);
  s.messages.set(key, held);
  if (thread) {
    const retracted = item.terminal?.state === 'retracted';
    const availability = held.v2!.availability ?? thread.availability;
    if (retracted !== thread.retracted || availability !== thread.availability) s.threads.set(key, { ...thread, retracted, availability });
  }
  return true;
}

export function applyRemoved(s: State, model: Model, itemId: string, rev: number): void {
  const key = model.keyFor(itemId);
  if (key) {
    const held = s.messages.get(key);
    if (held?.v2 && held.v2.rev >= rev) return;
    s.messages.delete(key);
    s.threads.delete(key);
  }
  model.tombstones.set(itemId, Math.max(rev, model.tombstones.get(itemId) ?? 0));
}

export function isOwnEntry(e: Entry, personId: string | null): boolean {
  return e.speaker ? e.speaker.kind === 'person' && e.speaker.id === personId : e.author === 'person';
}

export function isOwnTurn(t: Turn): boolean {
  return t.mine ?? t.author === 'person';
}

export function isIncomingReply(t: Turn): boolean {
  return t.kind === 'reply' && !isOwnTurn(t) && t.speaker?.kind !== 'server';
}

function toTurn(e: Entry, personId: string | null): Turn {
  const mine = isOwnEntry(e, personId);
  const kind = e.kind === 'reply' && mine ? 'discussion' : e.kind;
  return {
    id: e.entry_id,
    seq: e.position,
    ...(e.at_ms !== undefined ? { postedAt: e.at_ms } : {}),
    kind,
    author: e.author,
    ...(e.speaker ? { speaker: e.speaker, mine } : {}),
    text: e.text ?? '',
    files: (e.files ?? []).map(toWireFile),
    revision: e.request_revision,
    ...(e.in_reply_to ? { in_reply_to: e.in_reply_to } : {}),
    rev: e.rev,
    ...(mine && e.delivery ? { delivery: e.delivery } : {}),
    ...(e.state ? { state: e.state } : {}),
    ...(e.result ? { result: e.result } : {}),
  };
}

/** Start holding an item's conversation (the person opened it). */
export function wantThread(s: State, key: string): void {
  if (s.threads.has(key)) return;
  const m = s.messages.get(key);
  s.threads.set(key, {
    key,
    turns: [],
    availability: m?.v2?.availability ?? null,
    retracted: m?.terminal?.retracted ?? false,
    applied: new Set(),
  });
}

/**
 * Apply one Entry. Entries of items whose conversation the tab does not hold
 * are dropped; the conversation is read when the person opens the item.
 */
export function applyEntry(s: State, model: Model, e: Entry): boolean {
  const key = model.keyFor(e.item_id);
  if (!key) return false;
  const held = s.threads.get(key);
  if (!held) return false;
  const i = held.turns.findIndex((t) => t.id === e.entry_id);
  if (i >= 0 && (held.turns[i].rev ?? 0) >= e.rev) return false;
  const t: Thread = { ...held, turns: [...held.turns] };
  const turn = toTurn(e, model.personId);
  if (i >= 0) t.turns[i] = turn;
  else {
    // Entries sort by position, their creation order, which never changes.
    let at = t.turns.length;
    while (at > 0 && (t.turns[at - 1].seq ?? 0) > e.position) at--;
    t.turns.splice(at, 0, turn);
  }
  if (e.kind === 'availability' && e.availability) t.availability = e.availability.state;
  s.threads.set(key, t);
  return true;
}

// ---------- inbox order ----------

/** Compare by Unicode code point, which is UTF-8 byte order. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(i)!;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/**
 * The inbox as the store's view: every item, ascending by rank key, with
 * today's sections. History is drawn for resolved items and the free-order
 * groups where they change. An item with unread agent chat replies also gets
 * a reply row, sorted by its own key in the same space (else just before the
 * item), drawn from Chat.unread_replies and the newest origin reply.
 */
export function viewOf(s: State): ServerView {
  const held = [...s.messages.entries()].filter(([, m]) => m.v2);
  type Row = { sort: string; tie: number; key: string; item: ListItem };
  const rows: Row[] = [];
  let grouped = false;
  for (const [key, m] of held) {
    const v = m.v2!;
    if (v.group) grouped = true;
    const section: FreeSection = { state: v.section === 'resolved' ? 'history' : 'active', group: v.group ?? 'common' };
    rows.push({ sort: v.rankKey, tie: 1, key, item: { kind: 'message', key, section } });
    const turns = s.threads.get(key)?.turns;
    const reply = turns?.find((t) => t.id === v.lastOriginReply);
    const read = turns?.find((t) => t.id === v.readPosition)?.seq;
    const originUnread = !v.shared || v.readPosition === null ||
      (read != null && reply?.seq != null ? reply.seq > read : v.replyRankKey !== null);
    if ((v.unreadReplies ?? 0) > 0 && v.lastOriginReply && originUnread) {
      const seq = reply?.seq ?? 0;
      rows.push({
        sort: v.replyRankKey ?? v.rankKey,
        tie: 0,
        key,
        item: {
          kind: 'reply',
          key,
          section: { state: 'active', group: v.replyGroup ?? 'common' },
          conversationSeq: seq,
          openAt: seq,
          unseen: v.unreadReplies!,
          historical: false,
          priority: markOf(v.replyLevel, v.replyScore),
        },
      });
    }
  }
  rows.sort((a, b) => compareCodePoints(a.sort, b.sort) || a.tie - b.tie || compareCodePoints(a.key, b.key));
  const listItems = rows.map((r) => r.item);
  // Adjacent open items with the same (sender, thread) draw as one "N messages from" group.
  const entries = rows
    .filter((r) => r.item.kind === 'message')
    .map((r) => {
      const v = s.messages.get(r.key)!.v2!;
      return { key: r.key, thread: v.thread, priority: markOf(v.level, v.score) };
    });
  // Free order (the groups and their headings) applies only when the Server
  // sends groups and they come in today's order.
  return { entries, listItems, freeOrder: grouped && freeOrderValid(1, listItems) };
}

/**
 * The urgent and high marks, by today's web display rule: from the score when
 * there is one, at today's thresholds (urgent from 0.9, high from 0.7);
 * otherwise from the Server's level (now is urgent, high is high); with
 * neither, no mark (as for progress messages). Settings levels play no part.
 */
export function markOf(level: 'now' | 'high' | 'normal' | 'low' | null, score: number | null = null): 'urgent' | 'high' | null {
  if (score !== null && Number.isFinite(score)) return priorityOf(score);
  if (level !== null) return level === 'now' ? 'urgent' : level === 'high' ? 'high' : null;
  return null;
}

/** Unread chat: the newest agent reply is past the read position. */
export function v2Unread(m: HeldMessage, t: Thread | undefined): boolean {
  const v = m.v2;
  if (!v) return false;
  // The Server's count wins when it sends one.
  if (v.unreadReplies !== null) return v.unreadReplies > 0;
  if (!v.lastOriginReply) return false;
  if (v.readPosition === v.lastOriginReply) return false;
  if (v.readPosition && t) {
    const read = t.turns.find((x) => x.id === v.readPosition)?.seq;
    const last = t.turns.find((x) => x.id === v.lastOriginReply)?.seq;
    if (typeof read === 'number' && typeof last === 'number') return last > read;
  }
  return true;
}
