// Deployment configuration. Every address is a path on the hosted origin the
// page is served from, so nothing here names a host. A deployment can override
// any value by serving a `config.json` next to the page.

export interface Flags {
  /** Chat files: attach, upload and download (contract D-7). Off until the
   * Server's browser file routes are live. Off shows a file's name and size
   * only and offers no attach control (D-7f). */
  attachments: boolean;
}

export interface Config {
  /** WebSocket path for the browser relay connection (B-1). */
  relayPath: string;
  /** WebSocket subprotocol. Empty sends none. Browsers cannot send
   * `attention-relay/1` (a `/` is not allowed in a subprotocol token), so
   * this waits on the Server's choice. */
  relayProtocol: string;
  /** Base path of the browser file routes (D-7a). */
  filesPath: string;
  /** Server path that ends the sign-in and the hosted account session (F-2). */
  signOutPath: string;
  /** Server page to open when the sign-in has ended, so the Server's own
   * redirect to hosted sign-in applies (A-3). */
  sessionEndedPath: string;
  /** Hosted account page for plan and billing (E-1). */
  accountUrl: string;
  /** The Server's Components page: how to connect an agent (E-1). */
  componentsPath: string;
  /** The Server's Devices page (E-1, E-3). */
  devicesPath: string;
  /** JSON read of the signed-in account's display name (E-1, contract Q2).
   * Empty when the Server places the name in the page instead. */
  accountInfoPath: string;
  flags: Flags;
}

export const DEFAULT_CONFIG: Config = {
  relayPath: '/browser/relay',
  relayProtocol: '',
  filesPath: '/browser/v1',
  signOutPath: '/sign-out',
  sessionEndedPath: '/devices',
  accountUrl: '/account/',
  componentsPath: '/components',
  devicesPath: '/devices',
  accountInfoPath: '',
  flags: { attachments: false },
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
    const res = await fetch(new URL('config.json', document.baseURI), {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return DEFAULT_CONFIG;
    return mergeConfig(DEFAULT_CONFIG, await res.json());
  } catch {
    return DEFAULT_CONFIG;
  }
}
