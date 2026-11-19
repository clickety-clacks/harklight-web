// Applying client API v2 resources to the tab's store. One rule makes every
// order of reads, writes and feed events converge: a resource is applied only
// if its `rev` is newer than the one held (spec section 1). Removed items
// leave a tombstone, gated the same way.
//
// The store keeps its existing shape, so the UI reads v2 items as it reads
// relay messages: a message key is the item's sender plus its item_id.

import { seenValue } from '../state/message';
import type { State } from '../state/store';
import type { AnswerOutcome, HeldMessage, Terminal as HeldTerminal, Thread, Turn, WireFile } from '../state/types';
import { keyOf, splitKey } from '../state/types';
import type { ServerView } from '../state/view';
import type { Entry, FileRef, Item } from './wire';

/** Bookkeeping the store does not draw: tombstones and which threads are wanted. */
export class Model {
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

/** The answer the person or another of their devices gave, as an answer entry carries it. */
function answerText(t: Thread | undefined): string | undefined {
  if (!t) return undefined;
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i];
    if (turn.kind === 'answer' && turn.text !== '') return turn.text;
  }
  return undefined;
}

function terminalOf(
  t: { state: string; no_comment: boolean } | null,
  payload: HeldMessage['payload'],
  rev: number,
  thread: Thread | undefined,
): HeldTerminal | null {
  if (!t) return null;
  if (t.state === 'retracted') return { state: 'cleared', seq: rev, retracted: true, outcome: null };
  if (t.state !== 'answered') return { state: t.state as HeldTerminal['state'], seq: rev, retracted: false, outcome: null };
  if (t.no_comment) return { state: 'no_comment', seq: rev, retracted: false, outcome: { kind: 'no_comment' } };
  let outcome: AnswerOutcome | null = null;
  // A message whose only answer is Seen was answered Seen.
  if (seenValue(payload) !== null) outcome = { kind: 'seen' };
  else {
    const text = answerText(thread);
    if (text !== undefined) outcome = { kind: 'reply', text };
  }
  return { state: 'answered', seq: rev, retracted: false, outcome };
}

function toHeld(item: Item, thread: Thread | undefined): HeldMessage {
  const files = item.files.map(toWireFile);
  const wireTerminal = item.terminal ? { state: item.terminal.state, no_comment: item.terminal.no_comment === true } : null;
  return {
    sender_id: item.sender,
    message_id: item.item_id,
    payload: item.message,
    revision: item.request_revision,
    acceptedSeq: item.rev,
    terminal: terminalOf(wireTerminal, item.message, item.rev, thread),
    files,
    // The contract carries the current revision's files only; custom forms are checked against them until revision 1's files are available.
    firstFiles: files,
    chat: item.chat.available,
    v2: {
      item_id: item.item_id,
      rev: item.rev,
      rankKey: item.rank.key,
      score: item.rank.score ?? null,
      seen: item.seen,
      readPosition: item.chat.read_position ?? null,
      lastOriginReply: item.chat.last_origin_reply ?? null,
      availability: item.availability?.state ?? null,
      as: item.as ?? null,
      terminal: wireTerminal,
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
  const held = toHeld(item, thread);
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

function toTurn(e: Entry): Turn {
  // The person's chat turns read as `discussion`, the agent's as `reply`, as
  // the chat draws them; other kinds keep their own name and are not drawn.
  const kind = e.kind === 'reply' ? (e.author === 'person' ? 'discussion' : 'reply') : e.kind;
  return {
    id: e.entry_id,
    seq: e.position,
    kind,
    author: e.author,
    text: e.text ?? '',
    files: (e.files ?? []).map(toWireFile),
    revision: e.request_revision,
    ...(e.in_reply_to ? { in_reply_to: e.in_reply_to } : {}),
    rev: e.rev,
    ...(e.state ? { state: e.state } : {}),
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
    delivered: new Set(),
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
  const t: Thread = { ...held, turns: [...held.turns], delivered: new Set(held.delivered) };
  const turn = toTurn(e);
  if (i >= 0) t.turns[i] = turn;
  else {
    // Entries sort by position, their creation order, which never changes.
    let at = t.turns.length;
    while (at > 0 && (t.turns[at - 1].seq ?? 0) > e.position) at--;
    t.turns.splice(at, 0, turn);
  }
  if (e.delivery?.delivered || e.delivery?.acted) t.delivered.add(e.entry_id);
  if (e.kind === 'availability' && e.availability) t.availability = e.availability.state;
  s.threads.set(key, t);
  if (e.kind === 'answer') refreshAnswered(s, key);
  return true;
}

/** An answer entry can name the answer the item's terminal state does not carry. */
function refreshAnswered(s: State, key: string): void {
  const m = s.messages.get(key);
  if (!m?.v2) return;
  s.messages.set(key, { ...m, terminal: terminalOf(m.v2.terminal, m.payload, m.v2.rev, s.threads.get(key)) });
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

/** The inbox order as the store's view: every item, ascending by rank key. */
export function viewOf(s: State): ServerView {
  const held = [...s.messages.entries()].filter(([, m]) => m.v2);
  held.sort(([ka, a], [kb, b]) => compareCodePoints(a.v2!.rankKey, b.v2!.rankKey) || compareCodePoints(ka, kb));
  return {
    entries: held.map(([key, m]) => ({ key, score: m.v2!.score, thread: null })),
    listItems: held.map(([key]) => ({ kind: 'message' as const, key, section: null })),
    freeOrder: false,
  };
}

/** Unread chat: the newest agent reply is past the read position. */
export function v2Unread(m: HeldMessage, t: Thread | undefined): boolean {
  const v = m.v2;
  if (!v || !v.lastOriginReply) return false;
  if (v.readPosition === v.lastOriginReply) return false;
  if (v.readPosition && t) {
    const read = t.turns.find((x) => x.id === v.readPosition)?.seq;
    const last = t.turns.find((x) => x.id === v.lastOriginReply)?.seq;
    if (typeof read === 'number' && typeof last === 'number') return last > read;
  }
  return true;
}
