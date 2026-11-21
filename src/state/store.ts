// The tab's in-memory state and the small subscription the UI reads it with.
// The client API v2 session writes it; components only read it and call actions.

import type { Ui1Limits } from '../ui1/validate';
import type { ChatSend, ConnectionState, HeldMessage, Thread } from './types';
import type { ServerView } from './view';
import type { ErrorDetails } from '../v2/errorLog';
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
  /** The frozen request, sent again unchanged (same Idempotency-Key) by Retry. */
  resend?: { type: string; [key: string]: unknown };
}

export interface State {
  connection: ConnectionState;
  internalError: ErrorDetails | null;
  pictureRetry: number;
  displayName: string | null;
  messages: Map<string, HeldMessage>;
  threads: Map<string, Thread>;
  /** The inbox order, sections and reply rows, built from the held items. */
  view: ServerView | null;
  answers: Map<string, LocalAnswer>;
  chatSends: ChatSend[];
  /** True while older inbox pages remain on the Server. */
  morePages: boolean;
  /** The first inbox page has arrived. */
  loaded: boolean;
  chatAvailable: boolean;
  fileLimits: { inline: number; cap: number | null; ui1?: Ui1Limits } | null;
}

export function initialState(): State {
  return {
    connection: 'connecting',
    internalError: null,
    pictureRetry: 0,
    displayName: null,
    messages: new Map(),
    threads: new Map(),
    view: null,
    answers: new Map(),
    chatSends: [],
    morePages: false,
    loaded: false,
    chatAvailable: true,
    fileLimits: null,
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
      answers: new Map(this.state.answers),
      chatSends: [...this.state.chatSends],
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
}

// ---------- chat ----------

/** Items with a conversation accept replies in every message state. */
export function chatOpen(_t: Thread | undefined, m: HeldMessage | undefined): boolean {
  return !!m?.chat;
}

/** Unread chat: the Server's count of agent replies after the read position. */
export function hasUnread(s: State, key: string): boolean {
  const held = s.messages.get(key);
  return held ? v2Unread(held, s.threads.get(key)) : false;
}
