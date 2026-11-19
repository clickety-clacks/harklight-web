// A small EventSource for unit tests under Node, which has none. It follows
// the browser's rules the session relies on: a non-200 response or a wrong
// content type closes it for good (readyState 2) with an error and no
// status; a dropped stream fires an error, reconnects by itself and sends
// Last-Event-ID; comments (heartbeats) are never surfaced; an event's id
// updates the last event id, and an event without one leaves it unchanged.

import { request, type ClientRequest } from 'node:http';
import type { EventSourceLike } from '../../../src/v2/session';

type Listener = (ev: { data: string; lastEventId: string }) => void;

export class NodeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  lastEventId = '';
  /** Every request this source made: its URL and the Last-Event-ID it sent. */
  readonly opens: { url: string; lastEventId: string | null }[] = [];
  private listeners = new Map<string, Listener[]>();
  private req: ClientRequest | null = null;

  constructor(
    readonly url: string,
    private reconnectMs = 20,
  ) {
    this.connect();
  }

  addEventListener(type: string, listener: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(listener);
    this.listeners.set(type, l);
  }

  close(): void {
    this.readyState = 2;
    this.req?.destroy();
    this.req = null;
  }

  private fail(fatal: boolean): void {
    if (this.readyState === 2) return;
    this.req = null;
    if (fatal) this.readyState = 2;
    else this.readyState = 0;
    this.onerror?.({});
    if (!fatal && this.readyState === 0) setTimeout(() => this.readyState === 0 && this.connect(), this.reconnectMs);
  }

  private connect(): void {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.lastEventId !== '') headers['last-event-id'] = this.lastEventId;
    this.opens.push({ url: this.url, lastEventId: this.lastEventId === '' ? null : this.lastEventId });
    const req = request(this.url, { headers });
    this.req = req;
    req.on('response', (res) => {
      if (this.req !== req) return res.destroy();
      if (res.statusCode !== 200 || !String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
        res.resume();
        return this.fail(true);
      }
      this.readyState = 1;
      this.onopen?.({});
      let buf = '';
      let data: string[] = [];
      let event = 'message';
      let id: string | null = null;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            if (id !== null) this.lastEventId = id;
            if (data.length) for (const l of this.listeners.get(event) ?? []) l({ data: data.join('\n'), lastEventId: this.lastEventId });
            data = [];
            event = 'message';
            id = null;
            continue;
          }
          if (line.startsWith(':')) continue;
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'data') data.push(value);
          else if (field === 'event') event = value;
          else if (field === 'id') id = value;
        }
      });
      res.on('end', () => this.req === req && this.fail(false));
      res.on('error', () => this.req === req && this.fail(false));
    });
    req.on('error', () => this.req === req && this.fail(false));
    req.end();
  }
}
