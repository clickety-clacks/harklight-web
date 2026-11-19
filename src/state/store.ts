// The tab's in-memory state and the small subscription the UI reads it with.
// The relay session writes it; components only read it and call actions.

import type {
  AnswerOutcome,
  ChatSend,
  ConnectionState,
  HeldMessage,
  Json,
  JsonObject,
  LifecycleState,
  Terminal,
  Thread,
  Turn,
  WireFile,
} from './types';
import { keyOf } from './types';
import type { ServerView } from './view';
import { v2Unread } from '../v2/model';

/**
 * A submission's state, carried by the control the person tapped: sending
 * (a spinner), accepted (it becomes the answered card or the Seen check) or
 * failed (the failure mark, with Retry). Refused means the message closed or
 * was retracted first: no Retry, a short reason line instead. A refusal
 * because the message changed clears it, and the current message shows.
 */
export type AnswerSendState = 'sending' | 'accepted' | 'failed' | 'refused' | 'inactive';

export interface LocalAnswer {
  state: AnswerSendState;
  /** What the person picked, for the answered card. */
  label: string | null;
  seen: boolean;
  noComment: boolean;
  /** The control that was tapped: a choice id, 'no_comment', 'form' or 'seen'. */
  control: string;
  /** Typed text, kept so a failed reply can be retried as written. */
  text?: string;
  /** A custom form's draft, kept so a failed form shows what Retry sends. */
  draft?: unknown;
  reason?: string;
  /** The exact frame, sent again unchanged (same op_id) by Retry. */
  resend?: { type: string; [key: string]: unknown };
}

export interface State {
  connection: ConnectionState;
  displayName: string | null;
  messages: Map<string, HeldMessage>;
  threads: Map<string, Thread>;
  /** Account chat read positions: key -> conversation_seq read through. */
  readThrough: Map<string, number>;
  readSupport: boolean;
  /** The Server's priority view (order, sections, reply rows), if held. */
  view: ServerView | null;
  answers: Map<string, LocalAnswer>;
  chatSends: ChatSend[];
  /** True while older inbox pages remain on the Server. */
  morePages: boolean;
  /** The first inbox page has arrived. */
  loaded: boolean;
  chatAvailable: boolean;
  fileLimits: { inline: number; cap: number | null } | null;
  /** Lifecycle events for messages not yet held wait here until they arrive. */
  pendingTerminals: Map<string, Terminal>;
  /** Revisions for messages not yet held (their page has not loaded) wait here. */
  pendingRevisions: Map<string, PendingRevision>;
}

export interface PendingRevision {
  payload: JsonObject;
  revision: number;
  files: WireFile[];
}

export function initialState(): State {
  return {
    connection: 'connecting',
    displayName: null,
    messages: new Map(),
    threads: new Map(),
    readThrough: new Map(),
    readSupport: false,
    view: null,
    answers: new Map(),
    chatSends: [],
    morePages: false,
    loaded: false,
    chatAvailable: true,
    fileLimits: null,
    pendingTerminals: new Map(),
    pendingRevisions: new Map(),
  };
}

type Listener = () => void;

export class Store {
  state: State = initialState();
  private listeners = new Set<Listener>();
  private scheduled = false;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Replace the state object so readers see a change, and notify once per tick. */
  update(fn: (s: State) => void): void {
    const next: State = {
      ...this.state,
      messages: new Map(this.state.messages),
      threads: new Map(this.state.threads),
      readThrough: new Map(this.state.readThrough),
      answers: new Map(this.state.answers),
      chatSends: [...this.state.chatSends],
      pendingTerminals: new Map(this.state.pendingTerminals),
      pendingRevisions: new Map(this.state.pendingRevisions),
    };
    fn(next);
    this.state = next;
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        for (const l of this.listeners) l();
      });
    }
  }

  /** Forget everything the Server sent; a fresh inbox start follows. */
  resetInbox(): void {
    this.update((s) => {
      s.messages = new Map();
      s.threads = new Map();
      s.readThrough = new Map();
      s.view = null;
      s.pendingTerminals = new Map();
      s.pendingRevisions = new Map();
      s.loaded = false;
      s.morePages = false;
    });
  }
}

// ---------- applying relay events ----------

function obj(v: unknown): JsonObject | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseFiles(v: unknown): WireFile[] {
  if (!Array.isArray(v)) return [];
  const out: WireFile[] = [];
  for (const f of v) {
    const o = obj(f);
    if (!o || typeof o.name !== 'string') continue;
    out.push({
      name: o.name,
      size: num(o.size) ?? (typeof o.data_base64 === 'string' ? base64Size(o.data_base64) : undefined),
      sha256: typeof o.sha256 === 'string' ? o.sha256 : undefined,
      data_base64: typeof o.data_base64 === 'string' ? o.data_base64 : undefined,
      upload_id: typeof o.upload_id === 'string' ? o.upload_id : undefined,
    });
  }
  return out;
}

export function base64Size(b64: string): number {
  const clean = b64.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

const LIFECYCLE: LifecycleState[] = ['answered', 'no_comment', 'cleared', 'expired', 'superseded'];

export function parseOutcome(v: unknown): AnswerOutcome | null {
  const o = obj(v);
  if (!o) return null;
  const kind = o.kind;
  if (kind !== 'seen' && kind !== 'reply' && kind !== 'no_comment' && kind !== 'default') return null;
  return {
    kind,
    text: typeof o.text === 'string' ? o.text : undefined,
    value: 'value' in o ? (o.value as Json) : undefined,
  };
}

/** A lifecycle event becomes the message's terminal state. */
export function parseTerminal(ev: Record<string, unknown>): Terminal | null {
  let state = ev.state as LifecycleState;
  if (!LIFECYCLE.includes(state)) return null;
  const outcome = parseOutcome(ev.answer_outcome);
  if (ev.terminal_kind === 'no_comment' || outcome?.kind === 'no_comment') state = 'no_comment';
  return {
    state,
    seq: num(ev.seq) ?? 0,
    retracted: ev.terminal_reason === 'retracted',
    outcome,
  };
}

/** Apply a `delivery`. Returns false when the event carries no message. */
export function applyDelivery(s: State, ev: Record<string, unknown>): boolean {
  const payload = obj(ev.message);
  if (!payload || typeof ev.sender_id !== 'string' || typeof ev.message_id !== 'string') return false;
  const key = keyOf({ sender_id: ev.sender_id, message_id: ev.message_id });
  const prev = s.messages.get(key);
  const seq = num(ev.seq) ?? 0;
  // A delivery always carries revision 1. Later revisions arrive as
  // conversation events, possibly before this message's inbox page loads.
  const pending = s.pendingRevisions.get(key);
  s.pendingRevisions.delete(key);
  const newer = [prev && prev.revision > 1 ? prev : null, pending ?? null]
    .filter((x): x is { payload: JsonObject; revision: number; files: WireFile[] } => x !== null)
    .sort((a, b) => b.revision - a.revision)[0];
  s.messages.set(key, {
    sender_id: ev.sender_id,
    message_id: ev.message_id,
    payload: newer?.payload ?? payload,
    revision: newer?.revision ?? 1,
    acceptedSeq: Math.max(prev?.acceptedSeq ?? 0, seq),
    terminal: prev?.terminal ?? null,
    files: newer?.files ?? parseFiles(ev.files),
    firstFiles: parseFiles(ev.files),
    chat: typeof ev.session_handle === 'string' || (prev?.chat ?? false),
  });
  // A retraction can ride on the delivery.
  if (ev.terminal_reason === 'retracted' || typeof ev.retracted_at === 'number') {
    const m = s.messages.get(key)!;
    m.terminal = { state: 'cleared', seq, retracted: true, outcome: null };
  }
  return true;
}

export function applyLifecycle(s: State, ev: Record<string, unknown>): void {
  if (typeof ev.sender_id !== 'string' || typeof ev.message_id !== 'string') return;
  const t = parseTerminal(ev);
  if (!t) return;
  const key = keyOf({ sender_id: ev.sender_id, message_id: ev.message_id });
  const m = s.messages.get(key);
  if (!m) {
    s.pendingTerminals.set(key, t);
    return;
  }
  if (m.terminal && m.terminal.seq > t.seq) return;
  s.messages.set(key, { ...m, terminal: t });
}

export function takePendingTerminal(s: State, key: string): void {
  const t = s.pendingTerminals.get(key);
  const m = s.messages.get(key);
  if (!t || !m) return;
  s.pendingTerminals.delete(key);
  if (!m.terminal || m.terminal.seq < t.seq) s.messages.set(key, { ...m, terminal: t });
}

// ---------- conversations ----------

export function threadFor(s: State, key: string): Thread {
  let t = s.threads.get(key);
  if (!t) {
    const m = s.messages.get(key);
    t = { key, turns: [], availability: null, retracted: !!m?.terminal?.retracted, delivered: new Set(), applied: new Set() };
    s.threads.set(key, t);
  }
  return t;
}

/** New chat is open only while the message has a chat and no terminal state:
 * answering (including No comment), clearing, expiry, supersede and
 * retraction all close it. The conversation stays readable. */
export function chatOpen(t: Thread | undefined, m: HeldMessage | undefined): boolean {
  if (!m || !m.chat) return false;
  if (t?.retracted) return false;
  return m.terminal === null;
}

export function latestAgentReply(t: Thread | undefined): Turn | null {
  if (!t) return null;
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i];
    if (turn.kind === 'reply' && turn.author !== 'person') return turn;
  }
  return null;
}

export function hasUnread(s: State, key: string): boolean {
  const held = s.messages.get(key);
  if (held?.v2) return v2Unread(held, s.threads.get(key));
  const reply = latestAgentReply(s.threads.get(key));
  if (!reply) return false;
  if (!s.readSupport || reply.seq === null) return true;
  return reply.seq > (s.readThrough.get(key) ?? 0);
}

// ---------- conversation events ----------

function cloneThread(t: Thread): Thread {
  return { ...t, turns: [...t.turns], delivered: new Set(t.delivered), applied: new Set(t.applied) };
}

/**
 * Apply one `conversation` event. Chat turns, revisions, delivery facts,
 * availability, retraction and read positions all arrive this way.
 */
export function applyConversation(s: State, ev: Record<string, unknown>): void {
  if (typeof ev.sender_id !== 'string' || typeof ev.message_id !== 'string') return;
  const key = keyOf({ sender_id: ev.sender_id, message_id: ev.message_id });
  const seq = num(ev.conversation_seq);
  const kind = typeof ev.kind === 'string' ? ev.kind : '';

  if (kind === 'read_position') {
    const at = num(ev.read_through_conversation_seq);
    if (at !== null) s.readThrough.set(key, at);
    s.readSupport = true;
    return;
  }

  const t = cloneThread(threadFor(s, key));
  if (seq !== null) {
    if (t.applied.has(seq)) return;
    t.applied.add(seq);
  }
  s.threads.set(key, t);
  const eventId = typeof ev.event_id === 'string' ? ev.event_id : null;
  const author = (['person', 'origin', 'agent', 'server'] as const).find((a) => a === ev.author) ?? 'origin';
  const revision = num(ev.request_revision) ?? 1;

  switch (kind) {
    case 'discussion':
    case 'reply': {
      const turn: Turn = {
        id: eventId ?? `seq:${seq}`,
        seq,
        kind,
        author,
        text: typeof ev.text === 'string' ? ev.text : '',
        files: parseFiles(ev.files),
        revision,
        op_id: typeof ev.op_id === 'string' ? ev.op_id : undefined,
        in_reply_to: typeof ev.in_reply_to === 'string' ? ev.in_reply_to : undefined,
      };
      t.turns.push(turn);
      if (kind === 'reply' && turn.in_reply_to) t.delivered.add(turn.in_reply_to);
      // A chat send from this tab is done once its turn is in the history.
      if (turn.op_id) s.chatSends = s.chatSends.filter((c) => c.op_id !== turn.op_id);
      break;
    }
    case 'revision': {
      const m = s.messages.get(key);
      const message = obj(ev.message);
      if (!message) break;
      if (!m) {
        // Its inbox page has not loaded yet; apply when it does.
        const held = s.pendingRevisions.get(key);
        if (!held || revision > held.revision) s.pendingRevisions.set(key, { payload: message, revision, files: parseFiles(ev.files) });
      } else if (revision >= m.revision) {
        s.messages.set(key, { ...m, payload: message, revision, files: parseFiles(ev.files) });
      }
      break;
    }
    case 'receipt':
    case 'acted':
      if (eventId) t.delivered.add(eventId);
      break;
    case 'delivery_ack': {
      const handed = ev.stage === 'ack2' ? ev.outcome !== 'not_handed' : ev.ack2_expected === false;
      if (eventId && handed) t.delivered.add(eventId);
      break;
    }
    case 'availability': {
      const a = ev.availability;
      if (a === 'listening' || a === 'not_listening' || a === 'unsupported' || a === 'gone') t.availability = a;
      break;
    }
    case 'retraction': {
      t.retracted = true;
      const m = s.messages.get(key);
      if (m) {
        s.messages.set(key, {
          ...m,
          terminal: { state: 'cleared', seq: m.terminal?.seq ?? 0, retracted: true, outcome: null },
        });
      }
      break;
    }
    default:
      // result, file_transfer, file_use, attention_tier and unknown kinds
      // change nothing the web client shows.
      break;
  }
}

/** Apply the read positions carried by `conversation_resynced`. */
export function applyReadPositions(s: State, positions: unknown): void {
  if (!Array.isArray(positions)) {
    s.readSupport = false;
    return;
  }
  const map = new Map<string, number>();
  for (const p of positions) {
    const o = obj(p);
    if (!o || typeof o.sender_id !== 'string' || typeof o.message_id !== 'string') continue;
    const at = num(o.read_through_conversation_seq);
    if (at !== null) map.set(keyOf({ sender_id: o.sender_id, message_id: o.message_id }), at);
  }
  s.readThrough = map;
  s.readSupport = true;
}
