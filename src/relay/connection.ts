import { parse, stringify } from './json';

// One browser connection to the Server's relay (contract B-1). It sends one
// request at a time and hands every unsolicited frame to the listener, the way
// the iPhone app holds its socket for one exchange at a time.

export type Frame = { type: string; [key: string]: unknown };

/** Close codes the contract names (B-7). */
export const CLOSE_SESSION_ENDED = 4401;
export const CLOSE_INACTIVE = 4403;
export const CLOSE_REPLACED = 4409;
export const CLOSE_POLICY = 1008;

/** Frames that arrive without being asked for. */
const UNSOLICITED = new Set([
  'delivery',
  'lifecycle',
  'attention_tier',
  'resynced',
  'conversation',
  'conversation_resynced',
  'view_changed',
  'view_show',
]);

export interface Exchange {
  frame: Frame;
  /** Returns true when this frame ends the exchange. */
  done: (f: Frame) => boolean;
  resolve: (f: Frame) => void;
  reject: (e: Error) => void;
}

export class ConnectionClosed extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(`connection closed (${code}${reason ? ` ${reason}` : ''})`);
  }
}

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** `protocol` is empty when no subprotocol is sent. */
export type SocketFactory = (url: string, protocol: string) => SocketLike;

export interface ConnectionListener {
  /** An unsolicited frame, in arrival order. */
  frame(f: Frame): void;
  closed(code: number, reason: string): void;
}

export class Connection {
  private socket: SocketLike;
  private queue: Exchange[] = [];
  private current: Exchange | null = null;
  private closedWith: ConnectionClosed | null = null;
  readonly opened: Promise<void>;

  constructor(
    url: string,
    protocol: string,
    factory: SocketFactory,
    private listener: ConnectionListener,
  ) {
    this.socket = factory(url, protocol);
    this.opened = new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onclose = (ev) => {
        const err = new ConnectionClosed(ev.code, ev.reason);
        this.closedWith = err;
        reject(err);
        this.failAll(err);
        this.listener.closed(ev.code, ev.reason);
      };
    });
    // A rejected `opened` that nobody awaits must not surface as unhandled.
    this.opened.catch(() => undefined);
    this.socket.onerror = () => undefined;
    this.socket.onmessage = (ev) => this.receive(ev.data);
  }

  get isClosed(): boolean {
    return this.closedWith !== null;
  }

  close(code = 1000, reason = ''): void {
    if (!this.closedWith) this.socket.close(code, reason);
  }

  /** Send a frame and wait until `done` accepts a reply. */
  request(frame: Frame, done: (f: Frame) => boolean): Promise<Frame> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise((resolve, reject) => {
      this.queue.push({ frame, done, resolve, reject });
      this.pump();
    });
  }

  /** Send a frame whose reply nobody waits for. */
  send(frame: Frame): void {
    if (this.closedWith || this.socket.readyState !== 1) return;
    this.socket.send(stringify(frame) + '\n');
  }

  private pump(): void {
    if (this.current || this.closedWith || this.socket.readyState !== 1) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.socket.send(stringify(next.frame) + '\n');
  }

  /** Called once the socket opens so queued requests go out. */
  start(): void {
    this.pump();
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let f: Frame;
    try {
      f = parse(data) as Frame;
    } catch {
      return;
    }
    if (!f || typeof f !== 'object' || typeof f.type !== 'string') return;
    const cur = this.current;
    // Replays are part of an exchange: the frames between the `ok` and the
    // closing `resynced` belong to it, but they still go to the listener.
    if (UNSOLICITED.has(f.type)) {
      this.listener.frame(f);
      if (cur && cur.done(f)) this.finish(cur, f);
      return;
    }
    if (cur && cur.done(f)) {
      this.finish(cur, f);
      return;
    }
    this.listener.frame(f);
  }

  private finish(ex: Exchange, f: Frame): void {
    this.current = null;
    ex.resolve(f);
    this.pump();
  }

  private failAll(err: Error): void {
    const all = this.current ? [this.current, ...this.queue] : [...this.queue];
    this.current = null;
    this.queue = [];
    for (const ex of all) ex.reject(err);
  }
}

/** Matches the reply to a frame that carries `ref`. */
export function byRef(ref: string): (f: Frame) => boolean {
  return (f) => (f.type === 'ok' || f.type === 'error') && f.ref === ref;
}

/** Matches the next `ok` or `error` without a `ref` (answer frames carry none). */
export function refless(f: Frame): boolean {
  return (f.type === 'ok' || f.type === 'error') && f.ref === undefined;
}

export function uuid(): string {
  return crypto.randomUUID();
}
