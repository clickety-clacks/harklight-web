import '@fontsource/fraunces/300.css';
import '@fontsource/fraunces/400.css';
import './ui/theme.css';
import './ui/app.css';
import { render } from 'preact';
import { loadConfig } from './config';
import { RelaySession } from './relay/session';
import { Store } from './state/store';
import { App } from './ui/App';

async function main() {
  const config = await loadConfig();
  const store = new Store();
  const session = new RelaySession({
    config,
    store,
    socketFactory: (url, protocol) =>
      (protocol ? new WebSocket(url, protocol) : new WebSocket(url)) as unknown as import('./relay/connection').SocketLike,
    // The recipient id belongs to this tab only (C-1); session storage is per tab.
    storage: sessionStorage,
    files: config.flags.attachments ? { base: config.filesPath, fetch: (...a) => fetch(...a) } : undefined,
    onSessionEnded: () => {
      // A Server page: without a sign-in the Server sends the browser to
      // hosted sign-in (A-3).
      location.assign(config.sessionEndedPath);
    },
  });
  if (config.accountInfoPath) {
    fetch(config.accountInfoPath, { credentials: 'same-origin', redirect: 'manual' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && typeof j.display_name === 'string') store.update((s) => (s.displayName = j.display_name));
      })
      .catch(() => undefined);
  }
  window.addEventListener('online', () => session.nudge());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') session.nudge();
  });
  session.start();
  render(<App config={config} store={store} session={session} />, document.getElementById('app')!);
}

void main();
