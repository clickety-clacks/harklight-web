import { ApiError, call, type ApiDeps } from './http';

export type FocusScreen =
  | { screen: 'inbox' | 'settings' }
  | { screen: 'message'; item_id: string }
  | { screen: 'chat'; item_id: string; visible_entry_id?: string };

type FocusReport = FocusScreen | { screen: 'not_in_front' | 'signed_out' };

const DEBOUNCE_MS = 1_000;
const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SIGN_OUT_TIMEOUT_MS = 1_000;

export function browserDeviceName(ua: string): string {
  const browsers: [RegExp, string][] = [
    [/Edg(?:A|iOS)?\//, 'Edge'],
    [/OPR\/|Opera\//, 'Opera'],
    [/Firefox\/|FxiOS\//, 'Firefox'],
    [/Chrome\/|CriOS\//, 'Chrome'],
    [/Safari\//, 'Safari'],
  ];
  const systems: [RegExp, string][] = [
    [/iPhone|iPad|iPod/, 'iOS'],
    [/Android/, 'Android'],
    [/Windows/, 'Windows'],
    [/CrOS/, 'ChromeOS'],
    [/Macintosh|Mac OS X/, 'macOS'],
    [/Linux/, 'Linux'],
  ];
  const browser = browsers.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Browser';
  const os = systems.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Unknown OS';
  return `Web, ${browser} on ${os}`;
}

/** One reporter for the lifetime of the tab's signed-in session. */
export class FocusReporter {
  private current?: FocusScreen;
  private pending?: FocusReport;
  private inFlight?: Promise<void>;
  private controller?: AbortController;
  private debounce?: ReturnType<typeof setTimeout>;
  private refresh?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private api: Pick<ApiDeps, 'base' | 'fetch' | 'log'>, private deviceName: string) {
    document.addEventListener('visibilitychange', this.visibilityChanged);
  }

  update(report: FocusScreen): void {
    if (this.closed) return;
    const previous = this.current;
    const sameScreen = previous?.screen === report.screen;
    if (sameScreen &&
        ('item_id' in previous ? previous.item_id : undefined) === ('item_id' in report ? report.item_id : undefined) &&
        ('visible_entry_id' in previous ? previous.visible_entry_id : undefined) ===
          ('visible_entry_id' in report ? report.visible_entry_id : undefined)) return;
    this.current = report;
    if (!previous) {
      this.visibilityChanged();
    } else if (document.visibilityState === 'visible') {
      this.clearDebounce();
      if (sameScreen) {
        this.pending = undefined;
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          void this.offer(report);
        }, DEBOUNCE_MS);
      } else {
        void this.offer(report);
      }
    }
  }

  private visibilityChanged = (): void => {
    if (this.closed || !this.current) return;
    this.clearDebounce();
    clearInterval(this.refresh);
    if (document.visibilityState !== 'visible') {
      void this.offer({ screen: 'not_in_front' });
      return;
    }
    void this.offer(this.current);
    this.refresh = setInterval(() => {
      if (document.visibilityState === 'visible' && this.debounce === undefined && this.current) {
        void this.offer(this.current);
      }
    }, REFRESH_MS);
  };

  private offer(report: FocusReport): Promise<void> {
    this.pending = report;
    return this.flush() ?? Promise.resolve();
  }

  private flush(): Promise<void> | undefined {
    if (this.inFlight || !this.pending) return this.inFlight;
    const report = this.pending;
    this.pending = undefined;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    this.inFlight = call(this.api, '/devices/me/focus', {
      op: 'focus',
      method: 'PUT',
      json: { ...report, ttl_s: 120, ...(report.screen === 'signed_out' ? {} : { device_name: this.deviceName }) },
      signal: controller.signal,
    }).catch((error: unknown) => {
      // The transport logged the error. An older Server has no focus route.
      if (error instanceof ApiError && (error.status === 404 || error.status === 405)) this.dispose();
    }).finally(() => {
      clearTimeout(timeout);
      this.controller = undefined;
      this.inFlight = undefined;
      return this.flush();
    }).then(() => undefined);
    return this.inFlight;
  }

  private clearDebounce(): void {
    clearTimeout(this.debounce);
    this.debounce = undefined;
  }

  private stopUpdates(): void {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.clearDebounce();
    clearInterval(this.refresh);
  }

  dispose(): void {
    this.stopUpdates();
    this.pending = undefined;
    this.controller?.abort();
  }

  async signOut(): Promise<void> {
    if (this.closed) return;
    this.stopUpdates();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, SIGN_OUT_TIMEOUT_MS); });
    try {
      await Promise.race([this.offer({ screen: 'signed_out' }), deadline]);
    } finally {
      clearTimeout(timer);
      this.dispose();
    }
  }
}
