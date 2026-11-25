// Browser tabs share one cookie and one Server reporter. The newest foreground
// tab takes ownership. A Web Lock spans the PUT, including an ownership change.
const CHANNEL = 'harklight.browser-focus';
const OWNER = `${CHANNEL}.owner`;
const EVENT = `${CHANNEL}.event`;
const WRITE_LOCK = `${CHANNEL}.write`;

type Notice = { owner: string } | { disabled: true };

export class FocusTabs {
  private channel?: BroadcastChannel;
  private owner?: string;
  private claimId?: string;

  constructor(private disable: () => void) {
    try {
      if (typeof window.BroadcastChannel === 'function') this.channel = new BroadcastChannel(CHANNEL);
    } catch {
      // Fall back to storage events when the browser refuses the channel.
    }
    if (this.channel) this.channel.onmessage = (event: MessageEvent<Notice>) => this.receive(event.data);
    else window.addEventListener('storage', this.storageChanged);
  }

  claim(): void {
    const claim = `${(performance.timeOrigin + performance.now()).toFixed(3)}:${crypto.randomUUID()}`;
    this.claimId = this.owner = claim;
    // A synchronous read at send time also covers a claim whose notification
    // is still queued in the receiving tab.
    try {
      localStorage.setItem(OWNER, claim);
    } catch {
      // BroadcastChannel still works with storage disabled.
    }
    this.publish({ owner: claim });
  }

  owns(): boolean {
    if (!this.claimId) return false;
    let owner = this.owner;
    try {
      owner = localStorage.getItem(OWNER) ?? owner;
    } catch {
      if (!this.channel) return false;
    }
    return owner === this.claimId;
  }

  async write(send: () => Promise<void>): Promise<boolean | undefined> {
    // Focus is optional on origins/browsers without Web Locks. Sending there
    // could race another tab's PUT since the Server reporter is shared.
    return navigator.locks?.request(WRITE_LOCK, async () => {
      if (!this.owns()) return false;
      await send();
      return true;
    });
  }

  unsupported(): void {
    this.publish({ disabled: true });
  }

  close(): void {
    this.claimId = undefined;
    this.channel?.close();
    window.removeEventListener('storage', this.storageChanged);
  }

  private receive(notice: Notice): void {
    if ('disabled' in notice) this.disable();
    else if (!this.owner || notice.owner > this.owner) this.owner = notice.owner;
  }

  private publish(notice: Notice): void {
    if (this.channel) {
      this.channel.postMessage(notice);
    } else {
      try {
        localStorage.setItem(EVENT, JSON.stringify(notice));
        localStorage.removeItem(EVENT);
      } catch {
        // No shared owner can be announced when storage is unavailable.
      }
    }
  }

  private storageChanged = (event: StorageEvent): void => {
    if (event.key !== EVENT || !event.newValue) return;
    try {
      this.receive(JSON.parse(event.newValue));
    } catch {
      // Ignore an unrelated or malformed storage value.
    }
  };
}
