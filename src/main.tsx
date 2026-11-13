import '@fontsource/fraunces/300.css';
import '@fontsource/fraunces/400.css';
import './ui/theme.css';
import './ui/app.css';
import { render } from 'preact';
import { applyPreview, loadConfig } from './config';
import { RelaySession } from './relay/session';
import { Store } from './state/store';
import { App, NotYet } from './ui/App';

async function main() {
  let config = await loadConfig();
  try {
    config = applyPreview(config, location.hash, localStorage);
  } catch {
    // Storage can be unavailable; the flag then stays as configured.
  }
  if (location.hash === '#preview' || location.hash === '#preview-off') history.replaceState(history.state, '', location.pathname);
  // Typing #preview on an already open page changes only the hash; reload so it applies.
  window.addEventListener('hashchange', () => {
    if (location.hash === '#preview' || location.hash === '#preview-off') location.reload();
  });
  if (!config.flags.webClient) {
    // Off: no connection, no actions; only a notice.
    render(<NotYet config={config} />, document.getElementById('app')!);
    return;
  }
  const store = new Store();
  const session = new RelaySession({
    config,
    store,
    // No subprotocol: the browser door requires none and the client offers none (B-1).
    socketFactory: (url) => new WebSocket(url) as unknown as import('./relay/connection').SocketLike,
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
