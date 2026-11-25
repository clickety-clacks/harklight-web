import { useState } from 'preact/hooks';
import type { Config } from '../config';
import type { ConnectionState } from '../state/types';
import { Icon } from './Icon';
import { SignOutDialog } from './SignOutDialog';

const STATUS_TEXT: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  ended: 'Signed out',
  inactive: 'Account inactive',
  failed: 'Not connected',
};

// Settings, as the browser contract lists them (E-1): the account name, plan
// and billing on the hosted account page, connection status, Devices, how to
// connect an agent, and Sign out. Nothing the iPhone app lacks (E-2).
export function Settings(props: {
  config: Config;
  displayName: string | null;
  connection: ConnectionState;
  onBack: () => void;
  onSignOut: () => void | Promise<void>;
}) {
  const { config, displayName, connection } = props;
  const [asking, setAsking] = useState(false);
  const ok = connection === 'connected';
  return (
    <div class="page">
      <header class="page-head">
        <button type="button" class="icon-btn" onClick={props.onBack} aria-label="Back to inbox">
          <Icon name="back" />
        </button>
        <h1 class="page-title">Settings</h1>
      </header>
      <main class="page-main">
        <section class="group" aria-labelledby="g-account">
          <h2 id="g-account" class="label group-title">
            Account
          </h2>
          <div class="grow">
            <Icon name="user" />
            <span class="grow-l">Account</span>
            <span class="grow-v">{displayName ?? ''}</span>
          </div>
          {config.accountUrl && (
            <a class="grow" href={config.accountUrl} target="_blank" rel="noopener">
              <Icon name="card" />
              <span class="grow-l">Plan and billing</span>
              <span class="grow-v">
                <Icon name="ext" />
              </span>
            </a>
          )}
        </section>
        <section class="group" aria-labelledby="g-conn">
          <h2 id="g-conn" class="label group-title">
            Connection
          </h2>
          <div class="grow">
            <span class="grow-l">Connection status</span>
            <span class="grow-v">
              <span class={ok ? 'pill pill--ok' : 'pill'} data-testid="connection-status">
                {STATUS_TEXT[connection]}
              </span>
            </span>
          </div>
          {config.devicesPath && (
            <a class="grow" href={config.devicesPath}>
              <Icon name="phone" />
              <span class="grow-l">Devices</span>
              <span class="grow-v">
                <Icon name="chev" />
              </span>
            </a>
          )}
          {config.componentsPath && (
            <a class="grow" href={config.componentsPath} target="_blank" rel="noopener">
              <span class="grow-l">Connect an agent</span>
              <span class="grow-v">
                <Icon name="ext" />
              </span>
            </a>
          )}
        </section>
        {config.signOutPath && (
          <button type="button" class="btn btn--bordered btn--block" onClick={() => setAsking(true)}>
            Sign out
          </button>
        )}
      </main>
      {asking && <SignOutDialog action={config.signOutPath} onCancel={() => setAsking(false)} onSubmit={props.onSignOut} />}
    </div>
  );
}
