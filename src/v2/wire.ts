// Client API v2 resources, as the accepted field contract names them
// (docs/client-api-v2.md in the Server repository). Clients ignore members
// they do not know; these readers take only what the web client uses and
// drop anything malformed rather than guessing.

import { parse } from '../relay/json';
import type { Json, JsonObject } from '../state/types';

export interface FileRef {
  file_id: string;
  name: string;
  size: number;
  sha256: string;
  content_type?: string;
}

export type AvailabilityState = 'listening' | 'not_listening' | 'gone' | 'unsupported';
export type TerminalState = 'answered' | 'cleared' | 'expired' | 'superseded' | 'retracted';

/** The answer as the person sees it (today's answer outcome). `value` only for `default`. */
export interface Answer {
  kind: 'seen' | 'reply' | 'default' | 'no_comment';
  text?: string;
  value?: Json;
}

export interface Terminal {
  state: TerminalState;
  at_ms: number;
  answer?: Answer;
  /** By any client of this person. */
  by_this_person?: boolean;
}

export interface Item {
  item_id: string;
  rev: number;
  sender: string;
  request_revision: number;
  message: JsonObject;
  files: FileRef[];
  seen: boolean;
  as?: 'message' | 'knock';
  chat: {
    available: boolean;
    started: boolean;
    read_position?: string | null;
    last_origin_reply?: string | null;
    /** Agent replies after the read position, counted by the Server. */
    unread_replies?: number;
    /** While there are unread replies: the reply row's free-order group and its sort key, in Rank.key's space. */
    reply_group?: 'earlier_chat_replies' | 'earlier_chat_replies_unknown';
    reply_rank_key?: string;
  };
  /** When the item first reached the person. */
  created_at_ms?: number;
  availability?: { state: AvailabilityState; last_detached_at_ms?: number };
  terminal?: Terminal | null;
  rank: {
    key: string;
    score?: number;
    due_at_ms?: number;
    /** History is drawn for `resolved`. */
    section?: 'current' | 'resolved';
    /** For current items while the inbox is in free order; `common` has no heading. */
    group?: 'common' | 'earlier_messages';
  };
}

/** Answers live on Item.terminal and receipts on Entry.delivery, so neither is an entry kind. */
export type EntryKind = 'reply' | 'lifecycle' | 'revision' | 'availability';

export interface Entry {
  entry_id: string;
  item_id: string;
  rev: number;
  position: number;
  kind: EntryKind;
  author: 'person' | 'origin' | 'server';
  /** Absent on entries from before the cut-over. */
  at_ms?: number;
  request_revision: number;
  text?: string;
  files?: FileRef[];
  in_reply_to?: string;
  state?: 'active' | 'withdrawn' | 'retracted';
  terminal?: Terminal;
  availability?: { state: AvailabilityState };
  delivery?: { delivered?: boolean; acted?: boolean };
}

export interface InboxPage {
  rev: number;
  items: Item[];
  next_page?: string;
}

export interface EntriesPage {
  rev: number;
  entries: Entry[];
  older: boolean;
}

export interface WriteResult {
  rev: number;
  item?: Item;
  entry?: Entry;
}

export interface FileCreated {
  file_id: string;
  name?: string;
  sha256: string;
  size: number;
}

export type ChangeKind = 'item' | 'item_removed' | 'entry' | 'counts' | 'settings';
export const CHANGE_KINDS: ChangeKind[] = ['item', 'item_removed', 'entry', 'counts', 'settings'];

export interface Change {
  rev: number;
  kind: ChangeKind;
  data: unknown;
}

/** The closed list of error tokens (contract section 7). */
export const ERROR_TOKENS = [
  'not_found',
  'invalid_field',
  'stale_request',
  'already_answered',
  'already_retracted',
  'idempotency_conflict',
  'precondition_failed',
  'cursor_expired',
  'unauthorized',
  'forbidden',
  'retry_later',
  'storage_unavailable',
  'payload_too_large',
  'unsupported',
  'account_paused',
] as const;

export type ErrorToken = (typeof ERROR_TOKENS)[number];

// ---------- readers ----------

type O = Record<string, unknown>;

function obj(v: unknown): O | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : null;
}

function int(v: unknown, min: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null;
}

function id(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : null;
}

function optId(v: unknown): string | null {
  return v === null || v === undefined ? null : id(v);
}

const AVAILABILITY: AvailabilityState[] = ['listening', 'not_listening', 'gone', 'unsupported'];
const TERMINAL: TerminalState[] = ['answered', 'cleared', 'expired', 'superseded', 'retracted'];
const ENTRY_KINDS: EntryKind[] = ['reply', 'lifecycle', 'revision', 'availability'];
const ANSWER_KINDS: Answer['kind'][] = ['seen', 'reply', 'default', 'no_comment'];

function readAnswer(v: unknown): Answer | undefined {
  const o = obj(v);
  if (!o || !ANSWER_KINDS.includes(o.kind as Answer['kind'])) return undefined;
  return {
    kind: o.kind as Answer['kind'],
    ...(typeof o.text === 'string' ? { text: o.text } : {}),
    ...('value' in o && o.value !== undefined ? { value: o.value as Json } : {}),
  };
}

export function readFileRef(v: unknown): FileRef | null {
  const o = obj(v);
  if (!o) return null;
  const file_id = id(o.file_id);
  const size = int(o.size, 0);
  if (!file_id || typeof o.name !== 'string' || size === null || typeof o.sha256 !== 'string') return null;
  return {
    file_id,
    name: o.name,
    size,
    sha256: o.sha256,
    ...(typeof o.content_type === 'string' ? { content_type: o.content_type } : {}),
  };
}

function readFiles(v: unknown): FileRef[] {
  if (!Array.isArray(v)) return [];
  return v.map(readFileRef).filter((f): f is FileRef => f !== null);
}

export function readTerminal(v: unknown): Terminal | null {
  const o = obj(v);
  if (!o || !TERMINAL.includes(o.state as TerminalState)) return null;
  const answer = readAnswer(o.answer);
  return {
    state: o.state as TerminalState,
    at_ms: int(o.at_ms, 0) ?? 0,
    ...(answer ? { answer } : {}),
    by_this_person: o.by_this_person === true,
  };
}

function readAvailability(v: unknown): { state: AvailabilityState } | undefined {
  const o = obj(v);
  return o && AVAILABILITY.includes(o.state as AvailabilityState) ? { state: o.state as AvailabilityState } : undefined;
}

export function readItem(v: unknown): Item | null {
  const o = obj(v);
  if (!o) return null;
  const item_id = id(o.item_id);
  const rev = int(o.rev, 1);
  const request_revision = int(o.request_revision, 1);
  const message = obj(o.message);
  const chat = obj(o.chat);
  const rank = obj(o.rank);
  if (!item_id || rev === null || request_revision === null || !message || typeof o.sender !== 'string') return null;
  if (!chat || !rank || typeof rank.key !== 'string') return null;
  return {
    item_id,
    rev,
    sender: o.sender,
    request_revision,
    message: message as JsonObject,
    files: readFiles(o.files),
    seen: o.seen === true,
    ...(o.as === 'message' || o.as === 'knock' ? { as: o.as } : {}),
    chat: {
      available: chat.available === true,
      started: chat.started === true,
      read_position: optId(chat.read_position),
      last_origin_reply: optId(chat.last_origin_reply),
      ...(int(chat.unread_replies, 0) !== null ? { unread_replies: chat.unread_replies as number } : {}),
      ...(chat.reply_group === 'earlier_chat_replies' || chat.reply_group === 'earlier_chat_replies_unknown' ? { reply_group: chat.reply_group } : {}),
      ...(typeof chat.reply_rank_key === 'string' ? { reply_rank_key: chat.reply_rank_key } : {}),
    },
    ...(int(o.created_at_ms, 0) !== null ? { created_at_ms: o.created_at_ms as number } : {}),
    availability: readAvailability(o.availability),
    terminal: readTerminal(o.terminal),
    rank: {
      key: rank.key,
      ...(typeof rank.score === 'number' && Number.isFinite(rank.score) ? { score: rank.score } : {}),
      ...(rank.section === 'current' || rank.section === 'resolved' ? { section: rank.section } : {}),
      ...(rank.group === 'common' || rank.group === 'earlier_messages' ? { group: rank.group } : {}),
    },
  };
}

export function readEntry(v: unknown): Entry | null {
  const o = obj(v);
  if (!o) return null;
  const entry_id = id(o.entry_id);
  const item_id = id(o.item_id);
  const rev = int(o.rev, 1);
  const position = int(o.position, 0);
  if (!entry_id || !item_id || rev === null || position === null) return null;
  if (!ENTRY_KINDS.includes(o.kind as EntryKind)) return null;
  const author = o.author === 'person' || o.author === 'origin' || o.author === 'server' ? o.author : null;
  if (!author) return null;
  const state = o.state === 'active' || o.state === 'withdrawn' || o.state === 'retracted' ? o.state : undefined;
  const delivery = obj(o.delivery);
  return {
    entry_id,
    item_id,
    rev,
    position,
    kind: o.kind as EntryKind,
    author,
    ...(int(o.at_ms, 0) !== null ? { at_ms: o.at_ms as number } : {}),
    request_revision: int(o.request_revision, 1) ?? 1,
    ...(typeof o.text === 'string' ? { text: o.text } : {}),
    files: readFiles(o.files),
    ...(id(o.in_reply_to) ? { in_reply_to: o.in_reply_to as string } : {}),
    ...(state ? { state } : {}),
    ...(readTerminal(o.terminal) ? { terminal: readTerminal(o.terminal)! } : {}),
    ...(readAvailability(o.availability) ? { availability: readAvailability(o.availability)! } : {}),
    ...(delivery ? { delivery: { delivered: delivery.delivered === true, acted: delivery.acted === true } } : {}),
  };
}

export function readInboxPage(v: unknown): InboxPage | null {
  const o = obj(v);
  const rev = int(o?.rev, 0);
  if (!o || rev === null || !Array.isArray(o.items)) return null;
  return {
    rev,
    items: o.items.map(readItem).filter((i): i is Item => i !== null),
    ...(id(o.next_page) ? { next_page: o.next_page as string } : {}),
  };
}

export function readEntriesPage(v: unknown): EntriesPage | null {
  const o = obj(v);
  const rev = int(o?.rev, 0);
  if (!o || rev === null || !Array.isArray(o.entries)) return null;
  return { rev, entries: o.entries.map(readEntry).filter((e): e is Entry => e !== null), older: o.older === true };
}

export function readWriteResult(v: unknown): WriteResult | null {
  const o = obj(v);
  const rev = int(o?.rev, 0);
  if (!o || rev === null) return null;
  const item = o.item === undefined ? undefined : readItem(o.item);
  const entry = o.entry === undefined ? undefined : readEntry(o.entry);
  return { rev, ...(item ? { item } : {}), ...(entry ? { entry } : {}) };
}

export function readFileCreated(v: unknown): FileCreated | null {
  const o = obj(v);
  const file_id = id(o?.file_id);
  const size = int(o?.size, 0);
  if (!o || !file_id || size === null || typeof o.sha256 !== 'string') return null;
  return { file_id, sha256: o.sha256, size, ...(typeof o.name === 'string' ? { name: o.name } : {}) };
}

/** One feed event: `id` is the change's rev, `event` its kind. */
export function readChange(kind: string, lastEventId: string, data: string): Change | null {
  if (!CHANGE_KINDS.includes(kind as ChangeKind)) return null;
  if (!/^[0-9]+$/.test(lastEventId)) return null;
  const rev = Number(lastEventId);
  if (!Number.isSafeInteger(rev) || rev < 1) return null;
  let parsed: unknown;
  try {
    // Message content keeps numbers exactly as written (relay/json).
    parsed = parse(data);
  } catch {
    return null;
  }
  return { rev, kind: kind as ChangeKind, data: parsed };
}

/** One element of a JSON change batch: `{rev, kind, data}`. */
export function readBatchChange(v: unknown): Change | null {
  const o = obj(v);
  const rev = int(o?.rev, 1);
  if (!o || rev === null || !CHANGE_KINDS.includes(o.kind as ChangeKind)) return null;
  return { rev, kind: o.kind as ChangeKind, data: o.data };
}

/** What GET /v2/me says about this person's account and limits. */
export interface Me {
  paused: boolean;
  /** Per-file upload cap in bytes, or null for none. */
  uploadCap: number | null;
  inlineBudget: number;
  answerUiLimits: Record<string, number> | null;
}

export function readMe(v: unknown): Me | null {
  const o = obj(v);
  const limits = obj(o?.limits);
  if (!o || !limits) return null;
  const cap = limits.upload_cap_bytes_per_file;
  // answer_ui_limits sits beside `limits` in the Server's contract doc and
  // inside it in an earlier ruling; either is read.
  const ui = obj(o.answer_ui_limits) ?? obj(limits.answer_ui_limits);
  const caps: Record<string, number> = {};
  for (const [k, n] of Object.entries(ui ?? {})) if (int(n, 0) !== null) caps[k] = n as number;
  return {
    paused: obj(o.account)?.state === 'paused',
    uploadCap: int(cap, 0),
    inlineBudget: int(limits.inline_decoded_bytes_per_entry, 0) ?? 0,
    answerUiLimits: ui ? caps : null,
  };
}

export type { Json };
