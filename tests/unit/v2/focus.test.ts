// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorLog } from '../../../src/v2/errorLog';
import { FocusReporter, browserDeviceName } from '../../../src/v2/focus';

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

function ok() {
  return new Response('{"rev":2,"show":{"ignored":true}}');
}

describe('browser focus', () => {
  let visibility: ReturnType<typeof vi.spyOn>;
  let log: ErrorLog;
  let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  let reporter: FocusReporter;
  const reports = () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  const show = (state: DocumentVisibilityState) => {
    visibility.mockReturnValue(state);
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(navigator, 'locks', {
      configurable: true, value: { request: (_name: string, run: () => unknown) => run() },
    });
    visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    log = new ErrorLog();
    fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => ok());
    reporter = new FocusReporter({ base: '/v2', fetch, log }, 'Web, Chrome on Linux');
  });

  afterEach(() => {
    reporter.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports screen changes immediately and debounces changes within the same screen', async () => {
    reporter.update({ screen: 'inbox' });
    await tick();
    reporter.update({ screen: 'message', item_id: 'first' });
    await tick();
    reporter.update({ screen: 'message', item_id: 'second' });
    await tick(700);
    reporter.update({ screen: 'message', item_id: 'third' });
    await tick(999);
    expect(reports().map((r) => r.item_id)).toEqual([undefined, 'first']);
    await tick(1);
    expect(reports().map((r) => r.item_id)).toEqual([undefined, 'first', 'third']);
    expect(fetch).toHaveBeenLastCalledWith('/v2/devices/me/focus', expect.objectContaining({
      method: 'PUT', credentials: 'same-origin',
    }));
    expect(reports().at(-1)).toEqual({
      screen: 'message', item_id: 'third', ttl_s: 120, device_name: 'Web, Chrome on Linux',
    });
  });

  it('refreshes every minute when visible and reports the latest screen on return', async () => {
    reporter.update({ screen: 'inbox' });
    await tick(59_999);
    expect(reports()).toHaveLength(1);
    await tick(1);
    expect(reports().map((r) => r.screen)).toEqual(['inbox', 'inbox']);
    show('hidden');
    reporter.update({ screen: 'chat', item_id: 'item', visible_entry_id: 'entry' });
    await tick(120_000);
    expect(reports().map((r) => r.screen)).toEqual(['inbox', 'inbox', 'not_in_front']);
    expect(reports().at(-1)).not.toHaveProperty('item_id');
    show('visible');
    await tick();
    expect(reports().at(-1)).toMatchObject({ screen: 'chat', item_id: 'item', visible_entry_id: 'entry' });
    await tick(60_000);
    expect(reports().map((r) => r.screen)).toEqual(['inbox', 'inbox', 'not_in_front', 'chat', 'chat']);
  });

  it('replaces queued reports with the latest while a request is in flight', async () => {
    let release!: (res: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    reporter.update({ screen: 'inbox' });
    reporter.update({ screen: 'message', item_id: 'first' });
    reporter.update({ screen: 'message', item_id: 'second' });
    await tick(1_000);
    expect(reports()).toHaveLength(1);
    release(ok());
    await tick();
    expect(reports().map((r) => [r.screen, r.item_id])).toEqual([['inbox', undefined], ['message', 'second']]);
  });

  it.each([403, 404, 405])('stops for this session after a %s', async (status) => {
    fetch.mockResolvedValueOnce(new Response('{}', { status }));
    reporter.update({ screen: 'inbox' });
    reporter.update({ screen: 'settings' });
    await tick();
    show('hidden');
    show('visible');
    await tick(120_000);
    await reporter.signOut();
    expect(reports()).toHaveLength(1);
    expect(log.list()).toEqual([expect.objectContaining({ op: 'focus', status })]);
  });

  it('logs a transient error and sends only on the next normal report', async () => {
    fetch.mockRejectedValueOnce(new Error('offline'));
    reporter.update({ screen: 'inbox' });
    await tick(59_999);
    expect(reports()).toHaveLength(1);
    expect(log.list()).toEqual([expect.objectContaining({ op: 'focus', token: 'network' })]);
    await tick(1);
    expect(reports()).toHaveLength(2);
  });

  it('replaces queued navigation with signed_out and stops reporting', async () => {
    let release!: (res: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    reporter.update({ screen: 'inbox' });
    reporter.update({ screen: 'settings' });
    const signedOut = reporter.signOut();
    release(ok());
    await signedOut;
    await tick(120_000);
    expect(reports().map((r) => r.screen)).toEqual(['inbox', 'signed_out']);
    expect(reports().at(-1)).toEqual({ screen: 'signed_out', ttl_s: 120 });
  });

  it('bounds the wait for sign-out when a request stalls', async () => {
    fetch.mockImplementationOnce((_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    reporter.update({ screen: 'inbox' });
    const signedOut = reporter.signOut();
    await tick(1_000);
    await signedOut;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(reports()).toHaveLength(1);
  });
});

it('uses a short browser and OS name, including for unfamiliar user agents', () => {
  expect(browserDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/132.0 Safari/537.36 Edg/132.0'))
    .toBe('Web, Edge on macOS');
  expect(browserDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1'))
    .toBe('Web, Safari on iOS');
  expect(browserDeviceName('')).toBe('Web, Browser on Unknown OS');
});
