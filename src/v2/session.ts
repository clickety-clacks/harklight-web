// The tab's client API v2 session. It replaces the relay session behind the
// same store and the same actions the UI calls:
//
// - Snapshot Reader: GET /v2/inbox, /v2/items/{id} and /entries, by fetch.
// - Sync: one EventSource on GET /v2/changes. The cursor is the rev of the
//   last applied change; every resource is applied only if newer than held.
// - Actions: writes with an Idempotency-Key minted at the person's intent and
//   kept with the frozen request, resent with the same key after an unknown
//   outcome. Ordered per item, parallel across items. The write's response is
//   applied at once, by rev.
// - Error Log: Request-Id, status, token and closing reason.
//
// Writes never wait for the feed: the person can answer and chat while the
// feed reconnects.

import type { Config } from '../config';
import { parse } from '../relay/json';
import type { LocalAnswer, Store } from '../state/store';
import type { ChatSend, HeldMessage, Json } from '../state/types';
import { parseUi1Limits } from '../ui1/validate';
import { ErrorLog } from './errorLog';
import { ApiError, call, NetworkError, newKey, seg, type ApiDeps, type Response2 } from './http';
import { applyEntry, applyItem, applyRemoved, itemIdOf, keyOfItem, Model, viewOf, wantThread } from './model';
import {
  CHANGE_KINDS,
  readBatchChange,
  readChange,
  readEntriesPage,
  readEntry,
  readFileCreated,
  readInboxPage,
  readItem,
  readMe,
  readWriteResult,
  type Change,
  type InboxPage,
  type WriteResult,
} from './wire';

/** The part of the browser's EventSource the session uses. */
export interface EventSourceLike {
  /** 0 connecting, 1 open, 2 closed. */
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: { data: string; lastEventId: string }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface V2Deps {
  config: Config;
  store: Store;
  fetch: typeof fetch;
  eventSource: EventSourceFactory;
  /** The sign-in ended; the tab must leave for sign-in. */
  onSessionEnded: () => void;
  /** Scheme, host and port, for tests outside a browser. Empty in the page. */
  origin?: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  log?: ErrorLog;
  /** A feed silent this long (no change, no heartbeat) is treated as dead. Default 60 s. */
  livenessMs?: number;
}

/** Retry delays: from 1 s, doubling, capped at 60 s (spec section 6.1). */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
/** A 503 is resent this many times, after its Retry-After, before it shows as failed. */
const BUSY_RESENDS = 2;
/** At most this many older pages of one conversation are read. */
const ENTRY_PAGES = 20;
/** How often a paused tab asks whether the pause is lifted. */
const PAUSE_POLL_MS = 60_000;

/** A write as frozen at the person's intent: resent unchanged, with the same key. */
export interface FrozenWrite {
  type: 'v2';
  op: string;
  method: 'POST' | 'PUT';
  path: string;
  body: unknown;
  key: string;
  [k: string]: unknown;
}

class Ended extends Error {}

/**
 * The feed can bring the person's own chat turn before the reply's response
 * arrives. A person turn that looks like the oldest pending send hides it, so
 * the chat never shows it twice. It does not settle it: the turn may be the
 * same text from another device, so only the send's own response, replay or
 * failure does.
 */
function markLookalike(s: import('../state/store').State, key: string | undefined, e: import('./wire').Entry): void {
  if (!key || e.kind !== 'reply' || e.author !== 'person') return;
  if (s.chatSends.some((c) => c.lookalike === e.entry_id)) return;
  const i = s.chatSends.findIndex(
    (c) => c.key === key && c.state === 'sending' && !c.lookalike && c.text === (e.text ?? '') && c.files.length === (e.files?.length ?? 0),
  );
  if (i >= 0) s.chatSends = s.chatSends.map((c, j) => (j === i ? { ...c, lookalike: e.entry_id } : c));
}

export class V2Session {
  readonly log: ErrorLog;
  private model = new Model();
  private api: ApiDeps;
  /** The rev of the last change applied from the feed. */
  private cursor = 0;
  private feed: EventSourceLike | null = null;
  private nextPage: string | null = null;
  private paging: Promise<void> | null = null;
  private stopped = false;
  private attempt = 0;
  private retry: (() => void) | null = null;
  private recovering = false;
  private seenSent = new Set<string>();
  private readsInFlight = new Set<string>();
  /** Conversations read or being read: whole (`full`) or just the newest page, for a reply row. */
  private entriesLoading = new Map<string, { run: Promise<void>; full: boolean }>();
  /** The person left (sign-out): nothing restarts, not even a lifted pause. */
  private left = false;
  private queues = new Map<string, Promise<void>>();
  /** Files of a chat send: their upload keys and, once uploaded, their ids. */
  private chatFiles = new Map<string, { keys: Map<string, string>; ids: Map<string, string> }>();
  /** Chat sends with no response yet, resent with the same key once the feed is back. */
  private chatWaiting = new Set<string>();
  /** Answers resent once already after an unknown outcome (by key). */
  private autoResent = new Set<string>();
  private answerWaiting = new Set<string>();

  constructor(private deps: V2Deps) {
    this.log = deps.log ?? new ErrorLog();
    this.api = { base: `${deps.origin ?? ''}${deps.config.apiPath}`, fetch: deps.fetch, log: this.log };
  }

  private get store(): Store {
    return this.deps.store;
  }

  private timer(fn: () => void, ms: number): void {
    (this.deps.setTimer ?? setTimeout)(fn, ms);
  }

  /**
   * Writes never wait for the feed: the person can answer and chat while it
   * reconnects. Only a sign-in that ended, a paused account or a failure that
   * a retry will not fix stops them.
   */
  canWrite(s: { connection: string; loaded: boolean }): boolean {
    return s.loaded && (s.connection === 'connected' || s.connection === 'reconnecting' || s.connection === 'connecting');
  }

  /** Where a file is read from. */
  fileHref(fileId: string): string {
    return `${this.deps.config.apiPath}/files/${seg(fileId)}`;
  }

  // ---------- starting and stopping ----------

  start(): void {
    this.stopped = false;
    this.left = false;
    void this.baseline(false);
  }

  stop(): void {
    this.stopped = true;
    this.left = true;
    this.closeFeed();
  }

  /** Try now instead of waiting, for example when the network comes back. */
  nudge(): void {
    if (this.stopped || !this.retry) return;
    const run = this.retry;
    this.retry = null;
    this.attempt = 0;
    run();
  }

  /** After a failure a retry will not fix: start again, keeping what the tab holds. */
  tryAgain(): void {
    if (this.stopped || this.store.state.connection !== 'failed') return;
    this.attempt = 0;
    // Resume from the cursor when the tab holds an inbox, so nothing between
    // it and now is skipped; only a tab that never loaded starts afresh.
    if (this.store.state.loaded) void this.recover();
    else void this.baseline(false);
  }

  private later(run: () => void): void {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.retry = run;
    this.timer(() => {
      if (this.retry !== run) return;
      this.retry = null;
      run();
    }, delay);
  }

  private ended(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closeFeed();
    this.store.update((s) => {
      s.connection = 'ended';
    });
    this.deps.onSessionEnded();
  }

  /**
   * The account is paused (403 account_paused): what the tab holds stays
   * readable, nothing is sent, and the notice says messages are paused.
   */
  private inactive(): void {
    this.stopped = true;
    this.closeFeed();
    this.store.update((s) => {
      s.connection = 'inactive';
    });
    this.timer(() => void this.pollPause(), PAUSE_POLL_MS);
  }

  /** GET /v2/me stays answerable while paused: ask it until the pause is lifted, then carry on from the cursor. */
  private async pollPause(): Promise<void> {
    if (this.left || this.store.state.connection !== 'inactive') return;
    try {
      const me = readMe((await this.get('/me', 'me')).body);
      if (me && !me.paused) {
        this.stopped = false;
        this.attempt = 0;
        this.store.update((s) => {
          s.connection = 'reconnecting';
        });
        if (this.store.state.loaded) void this.recover();
        else void this.baseline(false);
        return;
      }
    } catch {
      // Asked again later.
    }
    this.timer(() => void this.pollPause(), PAUSE_POLL_MS);
  }

  /** A read failed: what the tab does next. */
  private readFailed(e: unknown, again: () => void): void {
    if (this.stopped) return;
    if (e instanceof Ended) return;
    if (e instanceof ApiError) {
      if (e.status === 401) return this.ended();
      if (e.token === 'account_paused') return this.inactive();
      if (!e.retryable && e.status !== 410) {
        this.store.update((s) => {
          s.connection = 'failed';
        });
        return;
      }
    }
    this.store.update((s) => {
      s.connection = s.loaded ? 'reconnecting' : 'connecting';
    });
    this.later(again);
  }

  // ---------- snapshot ----------

  private async get(path: string, op: string): Promise<Response2> {
    return call(this.api, path, { op });
  }

  private async inboxPage(page: string | null): Promise<InboxPage> {
    const r = await this.get(page ? `/inbox?page=${encodeURIComponent(page)}` : '/inbox', 'inbox');
    const p = readInboxPage(r.body);
    if (!p) throw new ApiError(r.status, 'unknown', r.requestId, false, null, null);
    return p;
  }

  /**
   * Read the inbox and open the feed from its rev. A full baseline reads every
   * page, drops what no page holds, and reads the held conversations again
   * (after the cursor expired, spec section 5.1).
   */
  private async baseline(full: boolean): Promise<void> {
    if (this.stopped) return;
    this.closeFeed();
    try {
      const first = await this.inboxPage(null);
      const pages = [first];
      if (full) {
        let next = first.next_page ?? null;
        while (next) {
          const p = await this.inboxPage(next);
          pages.push(p);
          next = p.next_page ?? null;
        }
      }
      if (this.stopped) return;
      this.store.update((s) => {
        if (full) {
          const keep = new Set(pages.flatMap((p) => p.items.map((i) => keyOfItem(i))));
          for (const [key, m] of s.messages) {
            if (m.v2 && !keep.has(key)) {
              s.messages.delete(key);
              s.threads.delete(key);
            }
          }
        }
        for (const p of pages) for (const item of p.items) applyItem(s, this.model, item);
        s.view = viewOf(s);
        s.loaded = true;
        s.readSupport = true;
        s.chatAvailable = true;
        s.morePages = !full && first.next_page !== undefined;
      });
      this.nextPage = full ? null : (first.next_page ?? null);
      // Anything that changed between pages has a change after the first
      // page's rev, so the feed delivers it.
      this.cursor = first.rev;
      if (full) {
        for (const key of [...this.entriesLoading.keys()]) if (!this.store.state.messages.has(key)) this.entriesLoading.delete(key);
        for (const key of this.store.state.threads.keys()) void this.loadEntries(key, { full: this.entriesLoading.get(key)?.full ?? true, again: true });
      }
      this.loadReplyThreads();
      this.openFeed();
      if (!this.store.state.fileLimits) void this.readMe();
    } catch (e) {
      this.readFailed(e, () => void this.baseline(full));
    }
  }

  /** File limits for the chat's pre-check; 413 stays the authority. */
  private async readMe(): Promise<void> {
    try {
      const me = readMe((await this.get('/me', 'me')).body);
      if (!me) return;
      this.store.update((s) => {
        // The answer-screen limits the Server publishes; the web's own generous set otherwise.
        const ui1 = parseUi1Limits(me.answerUiLimits);
        s.fileLimits = { inline: me.inlineBudget, cap: me.uploadCap, ...(ui1 ? { ui1 } : {}) };
      });
    } catch {
      // The upload's own answer still says when a file is too large.
    }
  }

  /** Load the next inbox page, if the Server has one. */
  async loadMore(): Promise<void> {
    if (this.paging) return this.paging;
    const page = this.nextPage;
    if (!page || this.stopped) return;
    this.paging = (async () => {
      try {
        const p = await this.inboxPage(page);
        this.nextPage = p.next_page ?? null;
        this.store.update((s) => {
          for (const item of p.items) applyItem(s, this.model, item);
          s.view = viewOf(s);
          s.morePages = this.nextPage !== null;
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) this.ended();
        // Otherwise the next scroll asks again.
      } finally {
        this.paging = null;
      }
    })();
    return this.paging;
  }

  /**
   * Read an item's conversation, newest page first, then older pages. A reply
   * row needs only the newest page (`full: false`); opening the item reads it
   * whole.
   */
  private loadEntries(key: string, opts: { full?: boolean; again?: boolean } = {}): Promise<void> {
    const full = opts.full ?? true;
    const held = this.entriesLoading.get(key);
    if (held && !opts.again && (held.full || !full)) return held.run;
    const itemId = itemIdOf(key);
    const run = (async () => {
      this.store.update((s) => wantThread(s, key));
      let before: string | null = null;
      for (let i = 0; i < (full ? ENTRY_PAGES : 1); i++) {
        const q: string = before ? `?before=${encodeURIComponent(before)}` : '';
        const r = await this.get(`/items/${seg(itemId)}/entries${q}`, 'entries');
        const page = readEntriesPage(r.body);
        if (!page) return;
        this.store.update((s) => {
          for (const e of page.entries) if (applyEntry(s, this.model, e)) markLookalike(s, key, e);
          s.view = viewOf(s);
        });
        if (!page.older || page.entries.length === 0) return;
        before = page.entries.reduce((a, b) => (b.position < a.position ? b : a)).entry_id;
      }
    })().catch((e) => {
      this.entriesLoading.delete(key);
      if (e instanceof ApiError && e.status === 401) this.ended();
    });
    this.entriesLoading.set(key, { run, full });
    return run;
  }

  private async refreshItem(key: string): Promise<void> {
    try {
      const r = await this.get(`/items/${seg(itemIdOf(key))}`, 'item');
      const item = readItem((r.body as { item?: unknown } | null)?.item);
      if (item) this.applyItems([item]);
    } catch {
      // The feed brings the change anyway.
    }
  }

  /** Unread agent replies show as inbox rows with their text: read those conversations. */
  private loadReplyThreads(): void {
    for (const [key, m] of this.store.state.messages) {
      if ((m.v2?.unreadReplies ?? 0) > 0 && !this.entriesLoading.has(key)) void this.loadEntries(key, { full: false });
    }
  }

  private applyItems(items: ReturnType<typeof readItem>[]): void {
    this.store.update((s) => {
      for (const item of items) if (item) applyItem(s, this.model, item);
      s.view = viewOf(s);
    });
  }

  private applyWrite(w: WriteResult | null): void {
    if (!w) return;
    this.store.update((s) => {
      if (w.item) applyItem(s, this.model, w.item);
      if (w.entry && applyEntry(s, this.model, w.entry)) markLookalike(s, this.model.keyFor(w.entry.item_id), w.entry);
      s.view = viewOf(s);
    });
  }

  // ---------- the change feed ----------

  private closeFeed(): void {
    const f = this.feed;
    this.feed = null;
    f?.close();
  }

  private openFeed(): void {
    if (this.stopped) return;
    this.closeFeed();
    const es = this.deps.eventSource(`${this.api.base}/changes?after=${this.cursor}`);
    this.feed = es;
    this.watchLiveness(es);
    es.onopen = () => {
      if (es !== this.feed) return;
      this.heard = Date.now();
      this.attempt = 0;
      this.store.update((s) => {
        s.connection = 'connected';
      });
      this.flushWaiting();
    };
    es.onerror = () => {
      if (es !== this.feed) return;
      if (es.readyState === 2) {
        // A fatal close: the browser will not reconnect, and hides why.
        this.log.record({ op: 'feed', status: null, token: 'unknown', requestId: null, closing: 'fatal' });
        this.feed = null;
        this.store.update((s) => {
          s.connection = 'reconnecting';
        });
        this.later(() => void this.recover());
        return;
      }
      // The browser reconnects by itself, with Last-Event-ID.
      this.log.record({ op: 'feed', status: null, token: 'network', requestId: null, closing: 'os_network' });
      this.store.update((s) => {
        s.connection = 'reconnecting';
      });
    };
    for (const kind of CHANGE_KINDS) {
      es.addEventListener(kind, (ev) => {
        if (es !== this.feed) return;
        this.heard = Date.now();
        const c = readChange(kind, ev.lastEventId, ev.data);
        if (c) this.applyChanges([c]);
      });
    }
    // The heartbeat carries no id: it only shows the feed is alive.
    es.addEventListener('heartbeat', () => {
      if (es === this.feed) this.heard = Date.now();
    });
    es.addEventListener('closing', (ev) => {
      if (es !== this.feed) return;
      let reason = 'unknown';
      try {
        const o = parse(ev.data) as { reason?: unknown };
        if (typeof o?.reason === 'string') reason = o.reason;
      } catch {
        // An unreadable closing still ends the feed.
      }
      this.log.record({ op: 'feed', status: null, token: 'closing', requestId: null, closing: reason });
      this.closeFeed();
      this.store.update((s) => {
        s.connection = 'reconnecting';
      });
      if (reason === 'account_paused') return this.inactive();
      // Revoked: the next request finds the sign-in ended (401). A shutdown: try again.
      if (reason === 'revoked') void this.recover();
      else this.later(() => void this.recover());
    });
  }

  private heard = 0;

  /**
   * The Server sends a heartbeat event at least every 25 s. A feed that says
   * nothing for the liveness window is dead even if the browser has not
   * noticed: it is closed and reopened from the cursor.
   */
  private watchLiveness(es: EventSourceLike): void {
    const window = this.deps.livenessMs ?? 60_000;
    this.heard = Date.now();
    const check = () => {
      if (es !== this.feed || this.stopped) return;
      const quiet = Date.now() - this.heard;
      if (quiet < window) return void this.timer(check, window - quiet);
      this.log.record({ op: 'feed', status: null, token: 'network', requestId: null, closing: 'silent' });
      this.store.update((s) => {
        s.connection = 'reconnecting';
      });
      this.openFeed();
    };
    this.timer(check, window);
  }

  private applyChanges(changes: Change[]): void {
    const fresh = changes.filter((c) => c.rev > this.cursor);
    if (fresh.length === 0) return;
    this.cursor = fresh[fresh.length - 1].rev;
    this.store.update((s) => {
      for (const c of fresh) {
        if (c.kind === 'item') {
          const item = readItem(c.data);
          if (item) applyItem(s, this.model, item);
        } else if (c.kind === 'item_removed') {
          const id = (c.data as { item_id?: unknown } | null)?.item_id;
          if (typeof id === 'string') {
            applyRemoved(s, this.model, id, c.rev);
            // If the item comes back, its conversation is read afresh.
            const key = this.model.keyFor(id);
            if (key && !s.messages.has(key)) this.entriesLoading.delete(key);
          }
        } else if (c.kind === 'entry') {
          const e = readEntry(c.data);
          if (e && applyEntry(s, this.model, e)) markLookalike(s, this.model.keyFor(e.item_id), e);
        }
        // counts and settings: nothing the web client draws.
      }
      s.view = viewOf(s);
    });
    this.loadReplyThreads();
  }

  /**
   * After the feed closed for good. EventSource hides the status, so ask with
   * fetch: the change batch from the cursor answers 401 when the sign-in
   * ended and 410 when the cursor expired (then the inbox is read again in
   * full). Otherwise its changes are applied and the feed reopens after them.
   */
  private async recover(): Promise<void> {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    try {
      const r = await this.get(`/changes?after=${this.cursor}`, 'changes');
      const b = r.body as { changes?: unknown } | null;
      const list = (Array.isArray(b?.changes) ? b!.changes : []).map(readBatchChange).filter((c): c is Change => c !== null);
      this.applyChanges(list);
      this.openFeed();
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        this.recovering = false;
        return void this.baseline(true);
      }
      this.readFailed(e, () => void this.recover());
    } finally {
      this.recovering = false;
    }
  }

  /** The feed is open again: resend what had no response. */
  private flushWaiting(): void {
    for (const op of [...this.chatWaiting]) {
      this.chatWaiting.delete(op);
      const c = this.store.state.chatSends.find((x) => x.op_id === op && x.state === 'sending');
      if (c) void this.sendReply(c);
    }
    for (const key of [...this.answerWaiting]) {
      this.answerWaiting.delete(key);
      const a = this.store.state.answers.get(key);
      if (a?.state === 'failed' && a.reason === 'connection' && a.resend) void this.resendAnswer(key, a.resend as FrozenWrite);
    }
  }

  // ---------- writes ----------

  /** Run writes for one item in order; different items run in parallel. */
  private enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch(() => undefined);
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  /** Send a frozen write, resending after 503 as Retry-After says. */
  private async write(w: FrozenWrite, file?: { bytes: Blob; name: string }): Promise<Response2> {
    for (let busy = 0; ; busy++) {
      try {
        return await call(this.api, w.path, {
          op: w.op,
          method: w.method,
          ...(file ? { bytes: file.bytes, fileName: file.name } : { json: w.body }),
          idempotencyKey: w.key,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          this.ended();
          throw new Ended();
        }
        if (e instanceof ApiError && e.token === 'account_paused') {
          this.inactive();
          throw e;
        }
        if (e instanceof ApiError && e.retryable && busy < BUSY_RESENDS) {
          await new Promise<void>((r) => this.timer(r, Math.min(e.retryAfterMs ?? 1000, 60_000)));
          continue;
        }
        throw e;
      }
    }
  }

  /** Mark Seen when the person opens the item, and read its conversation. */
  messageOpened(m: HeldMessage): void {
    if (!m.v2 || this.stopped) return;
    const key = keyOfItem({ sender: m.sender_id, item_id: m.v2.item_id });
    void this.loadEntries(key);
    const id = `${key}\u0000${m.revision}`;
    if (m.v2.seen || this.seenSent.has(id)) return;
    this.seenSent.add(id);
    const w: FrozenWrite = { type: 'v2', op: 'seen', method: 'POST', path: `/items/${seg(m.v2.item_id)}/seen`, body: {}, key: newKey() };
    void this.enqueue(key, async () => {
      try {
        const r = await this.write(w);
        this.applyWrite(readWriteResult(r.body));
      } catch (e) {
        if (!(e instanceof ApiError) || e.retryable) this.seenSent.delete(id);
      }
    });
  }

  /** Answer with a choice, typed text, a custom form's result, or Seen. */
  async answer(
    m: HeldMessage,
    value: Json,
    label: string | null,
    opts: { seen?: boolean; control: string; text?: string; draft?: unknown } = { control: 'choice' },
  ): Promise<void> {
    const body: Record<string, unknown> = { request_revision: m.revision };
    // The Seen action's id is `seen` (state/message seenValue).
    if (opts.seen) body.choice = 'seen';
    else if (opts.control === 'form') body.result = value;
    else if (opts.text !== undefined) body.comment = opts.text;
    else body.choice = opts.control;
    await this.sendAnswer(m, body, { label, seen: opts.seen ?? false, noComment: false, control: opts.control, text: opts.text, draft: opts.draft });
  }

  async noComment(m: HeldMessage): Promise<void> {
    await this.sendAnswer(m, { request_revision: m.revision }, { label: null, seen: false, noComment: true, control: 'no_comment' });
  }

  private async sendAnswer(
    m: HeldMessage,
    body: Record<string, unknown>,
    what: { label: string | null; seen: boolean; noComment: boolean; control: string; text?: string; draft?: unknown },
  ): Promise<void> {
    if (!m.v2) return;
    const key = keyOfItem({ sender: m.sender_id, item_id: m.v2.item_id });
    const w: FrozenWrite = { type: 'v2', op: 'answer', method: 'POST', path: `/items/${seg(m.v2.item_id)}/answer`, body, key: newKey() };
    this.store.update((s) => {
      s.answers.set(key, { state: 'sending', ...what, resend: w });
    });
    await this.resendAnswer(key, w);
  }

  /** Edit a failed answer: its frozen request is dropped; the next send is a new answer with a new key. */
  editFailedAnswer(key: string): void {
    if (this.store.state.answers.get(key)?.state !== 'failed') return;
    this.store.update((s) => {
      s.answers.delete(key);
    });
  }

  /** Retry a failed answer: the same request and key, so it can never apply twice. */
  retryAnswer(key: string): void {
    const a = this.store.state.answers.get(key);
    if (a?.state === 'failed' && a.resend) void this.resendAnswer(key, a.resend as FrozenWrite);
  }

  /** Update an answer's state, unless it was edited into a new answer meanwhile. */
  private setAnswer(key: string, patch: Partial<LocalAnswer>, w: FrozenWrite): void {
    this.store.update((s) => {
      const a = s.answers.get(key);
      if (a && a.resend === w) s.answers.set(key, { ...a, ...patch });
    });
  }

  private resendAnswer(key: string, w: FrozenWrite): Promise<void> {
    this.setAnswer(key, { state: 'sending', reason: undefined }, w);
    return this.enqueue(key, async () => {
      if (this.store.state.answers.get(key)?.resend !== w) return; // edited meanwhile
      try {
        const r = await this.write(w);
        // A replayed response is the original's: the answer went through.
        this.applyWrite(readWriteResult(r.body));
        this.setAnswer(key, { state: 'accepted', resend: undefined }, w);
      } catch (e) {
        if (e instanceof Ended) return;
        if (e instanceof NetworkError) {
          // Unknown outcome: shown as failed with Retry, and resent once with
          // the same key when the feed is open again.
          this.setAnswer(key, { state: 'failed', reason: 'connection' }, w);
          if (!this.autoResent.has(w.key)) {
            this.autoResent.add(w.key);
            this.answerWaiting.add(key);
            if (this.store.state.connection === 'connected') this.timer(() => this.flushWaiting(), BACKOFF_MS[0]);
          }
          return;
        }
        if (!(e instanceof ApiError)) throw e;
        const refused: Record<string, string> = { stale_request: 'stale_revision', already_answered: 'closed', already_retracted: 'retracted' };
        if (refused[e.token]) {
          // Not something Retry fixes: show it on the item and read the item again.
          this.setAnswer(key, { state: 'refused', reason: refused[e.token], resend: undefined }, w);
          void this.refreshItem(key);
          return;
        }
        if (e.token === 'account_paused') {
          this.setAnswer(key, { state: 'inactive', reason: 'inactive_account', resend: undefined }, w);
          return;
        }
        if (e.token === 'idempotency_conflict') {
          // A client defect: recorded, and never resent under a new key.
          this.setAnswer(key, { state: 'failed', reason: e.token, resend: undefined }, w);
          return;
        }
        this.setAnswer(key, { state: 'failed', reason: e.token }, w);
      }
    });
  }

  // ---------- chat ----------

  /** Send a chat reply. Files go up first with POST /v2/files, then the reply names them. */
  async chat(m: HeldMessage, text: string, files: ChatSend['files']): Promise<void> {
    if (!m.v2) return;
    const key = keyOfItem({ sender: m.sender_id, item_id: m.v2.item_id });
    const send: ChatSend = { op_id: newKey(), key, revision: m.revision, text, files, state: 'sending' };
    this.chatFiles.set(send.op_id, { keys: new Map(files.map((f) => [f.id, newKey()])), ids: new Map() });
    this.store.update((s) => {
      s.chatSends.push(send);
      wantThread(s, key);
    });
    await this.sendReply(send);
  }

  retryChat(opId: string): void {
    const c = this.store.state.chatSends.find((x) => x.op_id === opId);
    if (!c) return;
    this.updateSend(opId, { state: 'sending', reason: undefined });
    void this.sendReply({ ...c, state: 'sending' });
  }

  discardChat(opId: string): void {
    this.chatFiles.delete(opId);
    this.chatWaiting.delete(opId);
    this.store.update((s) => {
      s.chatSends = s.chatSends.filter((x) => x.op_id !== opId);
    });
  }

  private updateSend(opId: string, patch: Partial<ChatSend>): void {
    this.store.update((s) => {
      s.chatSends = s.chatSends.map((c) => (c.op_id === opId ? { ...c, ...patch } : c));
    });
  }

  private sendReply(send: ChatSend): Promise<void> {
    const itemId = itemIdOf(send.key);
    return this.enqueue(send.key, async () => {
      if (!this.store.state.chatSends.some((c) => c.op_id === send.op_id)) return; // discarded
      const files = this.chatFiles.get(send.op_id) ?? { keys: new Map<string, string>(), ids: new Map<string, string>() };
      this.chatFiles.set(send.op_id, files);
      try {
        for (const f of send.files) {
          if (files.ids.has(f.id)) continue;
          let k = files.keys.get(f.id);
          if (!k) files.keys.set(f.id, (k = newKey()));
          const up: FrozenWrite = { type: 'v2', op: 'file', method: 'POST', path: '/files', body: null, key: k };
          const r = await this.write(up, { bytes: f.file, name: f.name });
          const created = readFileCreated(r.body);
          if (!created) throw new ApiError(r.status, 'unknown', r.requestId, false, null, null);
          files.ids.set(f.id, created.file_id);
        }
        const body: Record<string, unknown> = { text: send.text };
        if (send.files.length > 0) body.file_ids = send.files.map((f) => files.ids.get(f.id)!);
        const w: FrozenWrite = { type: 'v2', op: 'reply', method: 'POST', path: `/items/${seg(itemId)}/replies`, body, key: send.op_id };
        const r = await this.write(w);
        this.chatFiles.delete(send.op_id);
        this.store.update((s) => {
          s.chatSends = s.chatSends.filter((c) => c.op_id !== send.op_id);
        });
        this.applyWrite(readWriteResult(r.body));
      } catch (e) {
        if (e instanceof Ended) return;
        if (e instanceof NetworkError) {
          // Still sending: resent with the same keys once the feed is back.
          this.chatWaiting.add(send.op_id);
          if (this.store.state.connection === 'connected') this.timer(() => this.flushWaiting(), BACKOFF_MS[0]);
          return;
        }
        if (!(e instanceof ApiError)) throw e;
        const reason = e.token === 'payload_too_large' ? 'upload_cap_exceeded' : e.token === 'account_paused' ? 'inactive_account' : e.token;
        this.updateSend(send.op_id, { state: 'failed', reason, lookalike: undefined });
      }
    });
  }

  /** Advance the chat read position to this agent reply (by its position). */
  markRead(key: string, position: number): void {
    const m = this.store.state.messages.get(key);
    const t = this.store.state.threads.get(key);
    if (!m?.v2 || !t || this.stopped) return;
    const turn = t.turns.find((x) => x.seq === position && x.kind === 'reply');
    if (!turn) return;
    const read = m.v2.readPosition ? t.turns.find((x) => x.id === m.v2!.readPosition)?.seq : undefined;
    if (m.v2.readPosition === turn.id || (typeof read === 'number' && read >= position)) return;
    const id = `${key}\u0000${turn.id}`;
    if (this.readsInFlight.has(id)) return;
    this.readsInFlight.add(id);
    const w: FrozenWrite = {
      type: 'v2',
      op: 'read_position',
      method: 'PUT',
      path: `/items/${seg(m.v2.item_id)}/read-position`,
      body: { entry_id: turn.id },
      key: newKey(),
    };
    void this.enqueue(key, async () => {
      try {
        const r = await this.write(w);
        this.applyWrite(readWriteResult(r.body));
      } catch {
        // Read again the next time the reply is on screen.
      } finally {
        this.readsInFlight.delete(id);
      }
    });
  }
}
