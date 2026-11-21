// Deployment configuration. Every address is a path on the hosted origin the
// page is served from, so nothing here names a host. A deployment can override
// any value by serving a `config.json` next to the page.

export interface Flags {
  /** The web client itself. Off for customers until the release: the page
   * shows a short "coming soon" note linking to Devices and opens no
   * connection. A tester can turn it on
   * in their own browser with `#preview` (and off with `#preview-off`). */
  webClient: boolean;
  /** Chat files: attach, upload and download (contract D-7). Off until the
   * Server's browser file routes are live. Off shows a file's name and size
   * only and offers no attach control (D-7f). */
  attachments: boolean;
  /** Custom answer forms (attention-client.ui/1). Off offers the plain Reply
   * and No comment, and says the custom screen is not shown. */
  answerForms: boolean;
  /** Talk to the Server through client API v2 (fetch reads, one change feed,
   * idempotent writes) instead of the browser relay WebSocket. A protocol
   * choice that must match the Server, so `#preview` leaves it as configured. */
  clientApiV2: boolean;
}

export interface Config {
  /** WebSocket path for the browser relay connection (B-1). */
  relayPath: string;
  /** Base path of the browser file routes (D-7a). */
  filesPath: string;
  /** Path of Harklight client API v2 on this origin. */
  apiPath: string;
  /** Server path that ends the sign-in and the hosted account session (F-2). */
  signOutPath: string;
  /** Server page to open when the sign-in has ended, so the Server's own
   * redirect to hosted sign-in applies (A-3). */
  sessionEndedPath: string;
  /** Hosted account page for plan and billing (E-1). Each link below may be
   * empty: a deployment without that page (a self-hosted Server has no
   * hosted account page) hides the row that leads to it. */
  accountUrl: string;
  /** The Server's Components page: how to connect an agent (E-1). */
  componentsPath: string;
  /** The Server's Devices page (E-1, E-3). */
  devicesPath: string;
  /** JSON read of the signed-in account's display name (E-1, contract Q2):
   * an authenticated GET answering {"display_name": ...}. */
  accountInfoPath: string;
  flags: Flags;
}

export const DEFAULT_CONFIG: Config = {
  relayPath: '/browser/relay',
  filesPath: '/browser/v1',
  apiPath: '/v2',
  signOutPath: '/sign-out',
  sessionEndedPath: '/devices',
  accountUrl: '/account/',
  componentsPath: '/components',
  devicesPath: '/devices',
  accountInfoPath: '/api/profile',
  flags: { webClient: false, attachments: false, answerForms: false, clientApiV2: false },
};

export function mergeConfig(base: Config, override: unknown): Config {
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;
  const out: Config = { ...base, flags: { ...base.flags } };
  for (const key of Object.keys(base) as (keyof Config)[]) {
    if (key === 'flags') continue;
    const v = o[key];
    if (typeof v === 'string') (out as unknown as Record<string, string>)[key] = v;
  }
  const flags = o.flags;
  if (flags && typeof flags === 'object') {
    for (const key of Object.keys(base.flags) as (keyof Flags)[]) {
      const v = (flags as Record<string, unknown>)[key];
      if (typeof v === 'boolean') out.flags[key] = v;
    }
  }
  return out;
}

export async function loadConfig(): Promise<Config> {
  try {
    // config.json sits next to the built files, under the build's base path.
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return DEFAULT_CONFIG;
    return mergeConfig(DEFAULT_CONFIG, await res.json());
  } catch {
    return DEFAULT_CONFIG;
  }
}

const PREVIEW_KEY = 'harklight.preview';

/**
 * A per-browser preview for testers: every feature flag on in this browser
 * only, so unreleased features (the client itself, custom forms, chat files)
 * can be checked live while customers keep the deployment's settings.
 */
export function applyPreview(config: Config, hash: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): Config {
  if (hash === '#preview') storage.setItem(PREVIEW_KEY, '1');
  if (hash === '#preview-off') storage.removeItem(PREVIEW_KEY);
  if (storage.getItem(PREVIEW_KEY) !== '1') return config;
  // clientApiV2 is the Server's protocol, not a feature: it keeps the deployment's value.
  return { ...config, flags: { ...config.flags, webClient: true, answerForms: true, attachments: true } };
}
