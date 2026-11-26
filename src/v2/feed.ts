import type { EventSourceLike } from './session';

type Listener = (event: { data: string; lastEventId: string }) => void;

/** Native EventSource cannot carry the headers required by a shared feed. */
export class SharedFeed implements EventSourceLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private controller = new AbortController();
  private listeners = new Map<string, Listener>();

  constructor(fetch: typeof globalThis.fetch, url: string, continuation: string) {
    void this.read(fetch, url, continuation);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.readyState = 2;
    this.controller.abort();
  }

  private async read(fetch: typeof globalThis.fetch, url: string, continuation: string): Promise<void> {
    const { signal } = this.controller;
    try {
      const response = await fetch(url, {
        credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal,
        headers: { accept: 'text/event-stream', 'harklight-continuation': continuation },
      });
      if (response.status === 410) {
        await response.body?.cancel();
        this.listeners.get('closing')?.({ data: '{"reason":"cursor_expired"}', lastEventId: '' });
        return;
      }
      if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new Error('Feed did not open');
      }
      this.readyState = 1;
      this.onopen?.(undefined);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      let event = '';
      let id = '';
      let data: string[] = [];
      let skipLF = false;
      try {
        while (!signal.aborted) {
          const part = await reader.read();
          if (part.done) break;
          if (part.value === '') continue;
          const chunk: string = skipLF && part.value.startsWith('\n') ? part.value.slice(1) : part.value;
          if (chunk === '') { skipLF = false; continue; }
          skipLF = chunk.endsWith('\r');
          const lines = (pending + chunk).split(/\r\n|[\r\n]/);
          pending = lines.pop()!;
          for (const line of lines) {
            if (signal.aborted) break;
            if (line === '') {
              if (data.length) this.listeners.get(event || 'message')?.({ data: data.join('\n'), lastEventId: id });
              event = '';
              id = '';
              data = [];
              continue;
            }
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            else if (field === 'id' && !value.includes('\0')) id = value;
            else if (field === 'data') data.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // The session diagnoses failures with a JSON batch from its applied cursor.
    }
    if (!signal.aborted) {
      this.close();
      this.onerror?.(undefined);
    }
  }
}
