// The tab's relay session: connects, loads the inbox, follows live events,
// reconnects by close code (contract B-7) and carries the person's actions.

import type { Config } from '../config';
import {
  applyConversation,
  applyDelivery,
  applyLifecycle,
  applyReadPositions,
  takePendingTerminal,
  type Store,
} from '../state/store';
import type { ChatSend, HeldMessage, Json } from '../state/types';
import { parseView } from '../state/view';
import { keyOf } from '../state/types';
import {
  byRef,
  CLOSE_INACTIVE,
  CLOSE_POLICY,
  CLOSE_REPLACED,
  CLOSE_SESSION_ENDED,
  Connection,
  ConnectionClosed,
  refless,
  uuid,
  type Frame,
  type SocketFactory,
} from './connection';
import { uploadFile, fetchFileLimits, discardUploads, type FileRoutes } from './files';


export interface SessionDeps {
  config: Config;
  store: Store;
  socketFactory: SocketFactory;
  /** Called when the sign-in ended; the tab must leave for sign-in (A-3). */
  onSessionEnded: () => void;
  location?: { protocol: string; host: string };
  setTimer?: (fn: () => void, ms: number) => unknown;
  files?: FileRoutes;
}

/** Retry delays after an unexpected close: increasing, then steady. */
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

class InactiveAccount extends Error {}

export class RelaySession {
  private conn: Connection | null = null;
  private recipientId: string;
  private snapshotId: string | null = null;
  private highWater = 0;
  /** Highest inbox sequence this tab has applied. */
  private cursor = 0;
  private nextCursor: string | null = null;
  /** Highest conversation sequence applied, and the highest acknowledged. */
  private convCursor = 0;
  private convAcked = 0;
  private viewRev: string | null = null;
  private attempt = 0;
  private stopped = false;
  private ready = false;
  /** The page load in flight, so callers can wait for it instead of skipping. */
  private paging: Promise<void> | null = null;
  private filling = false;
  private convAckScheduled = false;
  private viewFetchPending = false;
  private resyncingConversation = false;
  private sentOpens = new Set<string>();
  private readsInFlight = new Set<string>();

  constructor(private deps: SessionDeps) {
    // A tab's recipient id is made when the client starts and kept in memory
    // only (C-1): a reload or a duplicated tab starts with a new one. The
    // Server keeps a recipient's session between connections, and a session
    // that has started refuses a fresh inbox_start.
    this.recipientId = uuid();
  }

  private get store(): Store {
    return this.deps.store;
  }

  /** Start over on a new recipient: the old one's session cannot start again. */
  private newRecipient(): void {
    this.recipientId = uuid();
    this.snapshotId = null;
    this.convAcked = 0;
  }

  get recipient(): string {
    return this.recipientId;
  }

  private relayUrl(): string {
    const loc = this.deps.location ?? window.location;
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = this.deps.config.relayPath;
    return `${scheme}//${loc.host}${path}?recipient=${encodeURIComponent(this.recipientId)}`;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close(1000, 'leaving');
  }

  /** Reconnect now, for example when the network comes back. */
  nudge(): void {
    if (this.stopped || this.ready || !this.conn?.isClosed) return;
    this.attempt = 0;
    void this.connect();
  }

  // ---------- connecting ----------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.ready = false;
    this.store.update((s) => {
      if (s.connection !== 'connecting') s.connection = this.attempt === 0 && !s.loaded ? 'connecting' : 'reconnecting';
    });
    const conn = new Connection(this.relayUrl(), this.deps.socketFactory, {
      frame: (f) => this.onFrame(conn, f),
      closed: (code, reason) => this.onClosed(conn, code, reason),
    });
    this.conn = conn;
    try {
      await conn.opened;
      conn.start();
      await this.bootstrap(conn);
      if (conn !== this.conn) return;
      this.ready = true;
      this.attempt = 0;
      this.store.update((s) => {
        s.connection = 'connected';
      });
      void this.afterConnect(conn);
      // Bootstrap fetched the view before the connection was ready; page in
      // whatever it lists now.
      void this.fillForView();
    } catch (e) {
      if (e instanceof ConnectionClosed) return; // onClosed decides what happens next
      if (e instanceof InactiveAccount) {
        this.setInactive(conn);
        return;
      }
      // A protocol failure: drop the connection and start over, on a new
      // recipient, since this one's session may already have started.
      this.newRecipient();
      conn.close(4000, 'client restart');
    }
  }

  private async bootstrap(conn: Connection): Promise<void> {
    if (this.snapshotId) {
      // Resume the same snapshot after a dropped connection (B-7).
      const resumed = await this.replay(conn, this.cursor).catch((e) => {
        if (e instanceof ConnectionClosed || e instanceof InactiveAccount) throw e;
        return false;
      });
      if (resumed) {
        await this.openConversations(conn);
        await this.getView(conn);
        return;
      }
      // The connection is now bound to a dead replay; start over on a fresh
      // connection (the catch takes a new recipient).
      throw new Error('resume failed');
    }
    this.store.resetInbox();
    this.cursor = 0;
    this.convCursor = 0;
    this.convAcked = 0;
    const startRef = `start-${uuid()}`;
    const start = await this.req(conn, 
      { v: 1, type: 'inbox_start', paging_version: 1, startup_id: uuid(), since: 0, ref: startRef },
      byRef(startRef),
    );
    this.expectOk(start);
    this.snapshotId = String(start.snapshot_id);
    this.highWater = Number(start.high_water) || 0;
    this.cursor = this.highWater;
    this.applyItems(start.items);
    this.nextCursor = typeof start.next_cursor === 'string' ? start.next_cursor : null;
    this.store.update((s) => {
      s.loaded = true;
      s.morePages = this.nextCursor !== null;
    });

    // A browser originates no messages, so receipts are empty; follow the
    // cursor anyway if the Server offers one.
    let receipts = typeof start.receipt_cursor === 'string' ? start.receipt_cursor : null;
    while (receipts) {
      const ref = `receipts-${uuid()}`;
      const r = await this.req(conn, 
        { v: 1, type: 'inbox_receipts', paging_version: 1, snapshot_id: this.snapshotId, cursor: receipts, ref },
        byRef(ref),
      );
      this.expectOk(r);
      receipts = typeof r.next_cursor === 'string' ? r.next_cursor : null;
    }

    const ckRef = `checkpoint-${uuid()}`;
    const ck = await this.req(conn, 
      {
        v: 1,
        type: 'inbox_checkpoint_ack',
        paging_version: 1,
        snapshot_id: this.snapshotId,
        high_water: this.highWater,
        reconciled_batches: [],
        pending_manifest_complete: true,
        ref: ckRef,
      },
      byRef(ckRef),
    );
    this.expectOk(ck);
    if (!(await this.replay(conn, this.highWater))) throw new Error('replay refused');
    await this.openConversations(conn);
    await this.getView(conn);
  }

  /** inbox_attach replay: events after `since` up to `resynced`. */
  private async replay(conn: Connection, since: number): Promise<boolean> {
    const ref = `replay-${uuid()}`;
    const done = (f: Frame) => f.type === 'resynced' || (f.type === 'error' && f.ref === ref);
    const end = await this.req(conn, 
      { v: 1, type: 'inbox_attach', paging_version: 1, snapshot_id: this.snapshotId, mode: 'replay', since, ref },
      done,
    );
    if (end.type === 'error') {
      if (end.reason === 'inactive_account') throw new InactiveAccount();
      return false;
    }
    return true;
  }

  private async openConversations(conn: Connection): Promise<void> {
    const ref = `conversations-${uuid()}`;
    const done = (f: Frame) => f.type === 'conversation_resynced' || (f.type === 'error' && f.ref === ref);
    this.resyncingConversation = true;
    try {
      const end = await this.req(conn, { v: 1, type: 'conversation_open', since: this.convAcked, ref }, done);
      if (end.type === 'error') {
        if (end.reason === 'inactive_account') throw new InactiveAccount();
        if (end.reason === 'unknown_type') {
          this.store.update((s) => {
            s.chatAvailable = false;
          });
          return;
        }
        throw new Error(`conversation_open refused: ${String(end.reason)}`);
      }
      const high = Number(end.conversation_seq) || 0;
      this.convCursor = Math.max(this.convCursor, high);
      this.store.update((s) => {
        s.chatAvailable = true;
        applyReadPositions(s, end.chat_read_positions);
      });
    } finally {
      this.resyncingConversation = false;
    }
    await this.ackConversation(conn);
  }

  private async ackConversation(conn: Connection): Promise<void> {
    if (this.convCursor <= this.convAcked) return;
    const target = this.convCursor;
    const ref = `conversation-ack-${uuid()}`;
    const r = await this.req(conn, { v: 1, type: 'conversation_ack', conversation_seq: target, ref }, byRef(ref));
    if (r.type === 'ok') this.convAcked = Math.max(this.convAcked, target);
  }

  private async getView(conn: Connection): Promise<void> {
    const ref = `view-${uuid()}`;
    const frame: Frame = { v: 1, type: 'view_get', ref };
    if (this.viewRev) frame.known_view_rev = this.viewRev;
    const r = await this.req(conn, frame, byRef(ref));
    if (r.type !== 'ok') {
      if (r.reason === 'inactive_account') throw new InactiveAccount();
      this.viewRev = null;
      this.store.update((s) => {
        s.view = null;
      });
      return;
    }
    if (r.unchanged === true) return;
    this.viewRev = typeof r.view_rev === 'string' ? r.view_rev : null;
    const view = parseView(r);
    this.store.update((s) => {
      s.view = view;
    });
    // Load older pages until every message the view lists is held. During
    // bootstrap this waits for the connection to be ready (see connect).
    if (this.ready) void this.fillForView();
  }

  /** After connecting: settle anything this tab sent before the drop. */
  private async afterConnect(conn: Connection): Promise<void> {
    const routes = this.deps.files;
    if (routes && !this.store.state.fileLimits) {
      fetchFileLimits(routes, this.recipientId)
        .then((limits) => this.store.update((s) => (s.fileLimits = limits)))
        .catch(() => undefined);
    }
    const sends = this.store.state.chatSends.filter((c) => c.state === 'sending');
    for (const c of sends) void this.sendDiscussion(c);
    // Answers are not resent on their own: a dropped send shows Not sent with
    // Retry, and the replay above already settled any that went through.
    void conn;
  }

  private expectOk(f: Frame): void {
    if (f.type === 'ok') return;
    if (f.reason === 'inactive_account') throw new InactiveAccount();
    throw new Error(`refused: ${String(f.reason)}`);
  }

  private applyItems(items: unknown): void {
    if (!Array.isArray(items)) return;
    this.store.update((s) => {
      for (const it of items as Record<string, unknown>[]) {
        const acc = it?.acceptance as Record<string, unknown> | undefined;
        if (!acc || !applyDelivery(s, acc)) continue;
        const key = keyOf({ sender_id: String(acc.sender_id), message_id: String(acc.message_id) });
        if (it.terminal && typeof it.terminal === 'object') applyLifecycle(s, it.terminal as Record<string, unknown>);
        takePendingTerminal(s, key);
      }
    });
  }

  /** Page in older messages until every message the view lists is held. */
  private async fillForView(): Promise<void> {
    if (this.filling) return; // the running fill re-reads the view each page
    this.filling = true;
    try {
      await this.fillLoop();
    } finally {
      this.filling = false;
    }
  }

  private async fillLoop(): Promise<void> {
    for (;;) {
      const view = this.store.state.view;
      const missing = view?.listItems?.some((it) => !this.store.state.messages.has(it.key)) ?? false;
      if (!missing || !this.nextCursor || !this.ready) return;
      const before = this.store.state.messages.size;
      await this.loadMore();
      if (this.store.state.messages.size === before) return; // no progress
    }
  }

  /** Load the next older inbox page, if the Server has one. */
  async loadMore(): Promise<void> {
    if (this.paging) return this.paging; // wait for the page already loading
    const conn = this.conn;
    if (!conn || !this.ready || !this.nextCursor) return;
    this.paging = this.loadPage(conn).finally(() => {
      this.paging = null;
    });
    return this.paging;
  }

  private async loadPage(conn: Connection): Promise<void> {
    try {
      const ref = `page-${uuid()}`;
      const r = await this.req(
        conn,
        { v: 1, type: 'inbox_page', paging_version: 1, snapshot_id: this.snapshotId, cursor: this.nextCursor, ref },
        byRef(ref),
      );
      if (r.type !== 'ok') return;
      this.applyItems(r.items);
      this.nextCursor = typeof r.next_cursor === 'string' ? r.next_cursor : null;
      this.store.update((s) => {
        s.morePages = this.nextCursor !== null;
      });
    } catch {
      // A dropped connection resumes on reconnect.
    }
  }

  // ---------- incoming frames ----------

  private onFrame(conn: Connection, f: Frame): void {
    if (conn !== this.conn) return;
    switch (f.type) {
      case 'delivery':
      case 'lifecycle':
      case 'attention_tier':
        this.onSequenced(conn, f);
        break;
      case 'resynced':
        this.cursor = Math.max(this.cursor, Number(f.seq) || 0);
        break;
      case 'conversation':
        this.onConversation(conn, f);
        break;
      case 'view_changed':
        if (f.view_rev !== this.viewRev) this.scheduleView(conn);
        break;
      default:
        // view_show and other frames are not part of the browser contract.
        break;
    }
  }

  private onSequenced(conn: Connection, f: Frame): void {
    const seq = Number(f.seq);
    if (!Number.isInteger(seq) || seq <= this.cursor) return; // already applied
    if (seq !== this.cursor + 1) {
      // A gap: resume from what this tab holds on a fresh connection.
      conn.close(4000, 'sequence gap');
      return;
    }
    this.cursor = seq;
    if (f.type === 'attention_tier') return;
    this.store.update((s) => {
      if (f.type === 'delivery') {
        if (applyDelivery(s, f)) takePendingTerminal(s, keyOf({ sender_id: String(f.sender_id), message_id: String(f.message_id) }));
      } else applyLifecycle(s, f);
    });
  }

  private onConversation(conn: Connection, f: Frame): void {
    const seq = Number(f.conversation_seq);
    if (!Number.isInteger(seq) || seq <= this.convCursor) return;
    if (!this.resyncingConversation && seq !== this.convCursor + 1) {
      void this.resyncConversations(conn);
      return;
    }
    this.convCursor = seq;
    this.store.update((s) => applyConversation(s, f));
    if (!this.resyncingConversation) this.scheduleConvAck(conn);
  }

  private async resyncConversations(conn: Connection): Promise<void> {
    if (this.resyncingConversation) return;
    try {
      await this.openConversations(conn);
    } catch {
      // The connection dropped; the reconnect replays conversations.
    }
  }

  private scheduleConvAck(conn: Connection): void {
    if (this.convAckScheduled) return;
    this.convAckScheduled = true;
    queueMicrotask(() => {
      this.convAckScheduled = false;
      if (conn === this.conn && this.ready) this.ackConversation(conn).catch(() => undefined);
    });
  }

  private scheduleView(conn: Connection): void {
    if (this.viewFetchPending) return;
    this.viewFetchPending = true;
    queueMicrotask(() => {
      this.viewFetchPending = false;
      if (conn === this.conn) this.getView(conn).catch(() => undefined);
    });
  }

  // ---------- closing ----------

  private onClosed(conn: Connection, code: number, reason: string): void {
    if (conn !== this.conn) return;
    this.ready = false;
    if (this.stopped) return;
    if (code === CLOSE_SESSION_ENDED) {
      this.store.update((s) => {
        s.connection = 'ended';
      });
      this.deps.onSessionEnded();
      return;
    }
    if (code === CLOSE_INACTIVE) {
      this.setInactive(conn);
      return;
    }
    if (code === CLOSE_POLICY) {
      this.store.update((s) => {
        s.connection = 'failed';
      });
      return;
    }
    if (code === CLOSE_REPLACED) {
      // Another connection took this tab's recipient (for example a
      // duplicated tab). Take a new one and start over.
      this.newRecipient();
      this.store.update((s) => {
        s.connection = 'reconnecting';
      });
      void this.connect();
      return;
    }
    void reason;
    this.markInFlightUnconfirmed();
    this.store.update((s) => {
      s.connection = 'reconnecting';
    });
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    (this.deps.setTimer ?? setTimeout)(() => void this.connect(), delay);
  }

  /**
   * Send one request. A refusal because the account cannot use messaging
   * (B-5a) shows the account notice and stops the session, whatever the
   * request was.
   */
  private async req(conn: Connection, frame: Frame, done: (f: Frame) => boolean): Promise<Frame> {
    const r = await conn.request(frame, done);
    if (r.type === 'error' && r.reason === 'inactive_account' && conn === this.conn) this.setInactive(conn);
    return r;
  }

  private setInactive(conn: Connection): void {
    this.store.update((s) => {
      s.connection = 'inactive';
    });
    this.stopped = true;
    conn.close(1000, 'inactive');
  }

  private markInFlightUnconfirmed(): void {
    this.store.update((s) => {
      for (const [key, a] of s.answers) {
        if (a.state === 'sending') s.answers.set(key, { ...a, state: 'failed', reason: 'connection' });
      }
    });
  }

  // ---------- actions ----------

  /** Report that the person opened this message's detail (D-2). */
  messageOpened(m: HeldMessage): void {
    const conn = this.conn;
    const id = `${keyOf(m)}\u0000${m.revision}`;
    if (!conn || !this.ready || this.sentOpens.has(id)) return;
    this.sentOpens.add(id);
    const ref = `open-${uuid()}`;
    this.req(
      conn,
        {
          v: 1,
          type: 'message_open',
          op_id: uuid(),
          sender_id: m.sender_id,
          message_id: m.message_id,
          request_revision: m.revision,
          ref,
        },
        byRef(ref),
      )
      .then((r) => {
        if (r.type !== 'ok' && r.reason !== 'not_found' && r.reason !== 'invalid_field') this.sentOpens.delete(id);
      })
      .catch(() => this.sentOpens.delete(id));
  }

  /** Answer with a value (a choice, typed text, or Seen as JSON null). */
  async answer(
    m: HeldMessage,
    value: Json,
    label: string | null,
    opts: { seen?: boolean; control: string; text?: string; draft?: unknown } = { control: 'choice' },
  ): Promise<void> {
    const frame: Frame = {
      v: 1,
      type: 'answer',
      op_id: uuid(),
      sender_id: m.sender_id,
      message_id: m.message_id,
      answer: value,
      request_revision: m.revision,
    };
    await this.sendAnswer(keyOf(m), frame, {
      label,
      seen: opts.seen ?? false,
      noComment: false,
      control: opts.control,
      text: opts.text,
      draft: opts.draft,
    });
  }

  async noComment(m: HeldMessage): Promise<void> {
    // The Server takes exactly these three keys for No comment.
    const frame: Frame = { type: 'answer_no_comment', request_id: m.message_id, request_revision: m.revision };
    await this.sendAnswer(keyOf(m), frame, { label: null, seen: false, noComment: true, control: 'no_comment' });
  }

  private async sendAnswer(
    key: string,
    frame: Frame,
    what: { label: string | null; seen: boolean; noComment: boolean; control: string; text?: string; draft?: unknown },
  ): Promise<void> {
    this.store.update((s) => {
      s.answers.set(key, { state: 'sending', ...what, resend: frame });
    });
    await this.resendAnswer(key, frame);
  }

  /**
   * Edit a failed answer: its saved operation is dropped, and what the person
   * sends next is a new answer with a new op_id.
   */
  editFailedAnswer(key: string): void {
    if (this.store.state.answers.get(key)?.state !== 'failed') return;
    this.store.update((s) => {
      s.answers.delete(key);
    });
  }

  /** Retry a failed answer: the same frame and op_id, so it can never apply twice. */
  retryAnswer(key: string): void {
    const a = this.store.state.answers.get(key);
    if (a?.state === 'failed' && a.resend) void this.resendAnswer(key, a.resend);
  }

  private async resendAnswer(key: string, frame: Frame): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.ready) {
      this.store.update((s) => {
        const a = s.answers.get(key);
        if (a) s.answers.set(key, { ...a, state: 'failed', reason: 'connection' });
      });
      return;
    }
    this.store.update((s) => {
      const a = s.answers.get(key);
      if (a) s.answers.set(key, { ...a, state: 'sending' });
    });
    let r: Frame;
    try {
      r = await this.req(conn, frame, refless);
    } catch {
      return; // the close marks it failed, with Retry
    }
    this.store.update((s) => {
      const a = s.answers.get(key);
      if (!a) return;
      if (r.type === 'ok') {
        s.answers.set(key, { ...a, state: 'accepted', resend: undefined });
        return;
      }
      const reason = String(r.reason ?? '');
      if (reason === 'closed' || reason === 'retracted' || reason === 'stale_revision') {
        // Not something Retry fixes. Closed and retracted end the answer; a
        // changed message shows again, to be answered again.
        s.answers.set(key, { ...a, state: 'refused', reason, resend: undefined });
        return;
      }
      if (reason === 'inactive_account') {
        s.answers.set(key, { ...a, state: 'inactive', reason, resend: undefined });
        s.connection = 'inactive';
        return;
      }
      s.answers.set(key, { ...a, state: 'failed', reason });
    });
  }

  /** Send a chat message, uploading files first as the contract describes. */
  async chat(m: HeldMessage, text: string, files: ChatSend['files']): Promise<void> {
    const send: ChatSend = { op_id: uuid(), key: keyOf(m), revision: m.revision, text, files, state: 'sending' };
    this.store.update((s) => {
      s.chatSends.push(send);
    });
    await this.sendDiscussion(send);
  }

  retryChat(opId: string): void {
    const c = this.store.state.chatSends.find((x) => x.op_id === opId);
    if (!c) return;
    this.updateSend(opId, { state: 'sending', reason: undefined });
    void this.sendDiscussion({ ...c, state: 'sending' });
  }

  discardChat(opId: string): void {
    const c = this.store.state.chatSends.find((x) => x.op_id === opId);
    this.store.update((s) => {
      s.chatSends = s.chatSends.filter((x) => x.op_id !== opId);
    });
    if (c && c.files.length > 0 && this.deps.files) void discardUploads(this.deps.files, this.recipientId, c).catch(() => undefined);
  }

  private updateSend(opId: string, patch: Partial<ChatSend>): void {
    this.store.update((s) => {
      s.chatSends = s.chatSends.map((c) => (c.op_id === opId ? { ...c, ...patch } : c));
    });
  }

  private async sendDiscussion(send: ChatSend): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.ready) return; // stays "sending"; resent after reconnect
    const [sender_id, message_id] = send.key.split('\u0000');
    let files: unknown[] = [];
    if (send.files.length > 0) {
      const routes = this.deps.files;
      if (!routes) {
        this.updateSend(send.op_id, { state: 'failed', reason: 'files' });
        return;
      }
      try {
        files = await this.prepareFiles(routes, send, sender_id, message_id);
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'files';
        if (reason.startsWith('upload_cap_exceeded')) {
          this.updateSend(send.op_id, { state: 'failed', reason });
        } else if (reason === 'session_ended') {
          this.deps.onSessionEnded();
        } else {
          this.updateSend(send.op_id, { state: 'failed', reason });
        }
        return;
      }
    }
    const ref = `discussion-${uuid()}`;
    let r: Frame;
    try {
      r = await this.req(conn, 
        {
          v: 1,
          type: 'discussion',
          op_id: send.op_id,
          sender_id,
          message_id,
          request_revision: send.revision,
          text: send.text,
          files,
          ref,
        },
        byRef(ref),
      );
    } catch {
      return; // resent with the same op_id after reconnect (B-7)
    }
    if (r.type === 'ok') {
      // The turn itself arrives as a conversation event; until then it reads as sent.
      const held = this.store.state.chatSends.some((c) => c.op_id === send.op_id);
      if (held) this.updateSend(send.op_id, { state: 'sent' });
      return;
    }
    if (r.reason === 'closed') {
      this.updateSend(send.op_id, { state: 'closed', reason: 'closed' });
      if (send.files.length > 0 && this.deps.files) void discardUploads(this.deps.files, this.recipientId, send).catch(() => undefined);
      return;
    }
    this.updateSend(send.op_id, { state: 'failed', reason: String(r.reason ?? 'refused') });
  }

  private async prepareFiles(routes: FileRoutes, send: ChatSend, sender_id: string, message_id: string) {
    const limits = this.store.state.fileLimits ?? (await fetchFileLimits(routes, this.recipientId));
    if (!this.store.state.fileLimits) {
      this.store.update((s) => {
        s.fileLimits = limits;
      });
    }
    // Greedy in draft order: a file goes inline while the entry's inline
    // total stays within the limit; otherwise it is uploaded (D-7c).
    let budget = limits.inline;
    const out: unknown[] = [];
    for (const f of send.files) {
      if (f.size <= budget) {
        budget -= f.size;
        out.push({ name: f.name, data_base64: await toBase64(f.file) });
        continue;
      }
      if (limits.cap !== null && f.size > limits.cap) throw new Error(`upload_cap_exceeded:${limits.cap}`);
      const up = await uploadFile(routes, this.recipientId, {
        file: f.file,
        name: f.name,
        opId: send.op_id,
        senderId: sender_id,
        messageId: message_id,
        revision: send.revision,
      });
      out.push({ name: up.name, upload_id: up.upload_id, size: up.size, sha256: up.sha256 });
    }
    return out;
  }

  /** Advance the account's chat read position to this agent reply (D-5). */
  markRead(key: string, replySeq: number): void {
    const conn = this.conn;
    const s = this.store.state;
    if (!conn || !this.ready || !s.readSupport) return;
    if ((s.readThrough.get(key) ?? 0) >= replySeq) return;
    const id = `${key}\u0000${replySeq}`;
    if (this.readsInFlight.has(id)) return;
    this.readsInFlight.add(id);
    const [sender_id, message_id] = key.split('\u0000');
    const ref = `read-${uuid()}`;
    this.req(
      conn,
        {
          v: 1,
          type: 'conversation_read',
          op_id: uuid(),
          sender_id,
          message_id,
          read_through_conversation_seq: replySeq,
          ref,
        },
        byRef(ref),
      )
      .then((r) => {
        if (r.type === 'ok' && typeof r.read_through_conversation_seq === 'number') {
          const at = r.read_through_conversation_seq;
          this.store.update((st) => {
            if ((st.readThrough.get(key) ?? 0) < at) st.readThrough.set(key, at);
          });
        }
      })
      .catch(() => undefined)
      .finally(() => this.readsInFlight.delete(id));
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
