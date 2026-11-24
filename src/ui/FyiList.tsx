import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClientSession } from '../client';
import { body, createdAt, isFyi, messageType, title } from '../state/message';
import type { State } from '../state/store';
import type { HeldMessage } from '../state/types';
import { compareCodePoints } from '../v2/model';
import { MessageContent, MessageHeading } from './MessageContent';

export function fyiItems(state: State) {
  return [...state.messages].flatMap(([key, message]) => {
    if (!isFyi(message.payload) || message.terminal?.state === 'superseded') return [];
    const local = state.answers.get(key);
    const seen = !!message.v2?.seen || message.terminal?.outcome?.kind === 'seen';
    return [{ key, message, seen, sending: local?.state === 'sending', failed: !!(local?.seen && local.state === 'failed') }];
  });
}

function postedAt(message: HeldMessage) {
  return message.v2?.createdAt ?? createdAt(message);
}

type Item = ReturnType<typeof fyiItems>[number];
const byPosted = (a: Item, b: Item) =>
  (postedAt(b.message) ?? -Infinity) - (postedAt(a.message) ?? -Infinity) || compareCodePoints(a.key, b.key);
const priority = { now: 3, high: 2, normal: 1, low: 0 } as const;
const level = (item: Item) => priority[item.message.v2?.level ?? 'normal'];

export function FyiSummary({ items, incomplete, open }: { items: Item[]; incomplete: boolean; open: () => void }) {
  const latest = [...items].sort(byPosted)[0]?.message;
  const unseen = items.filter((item) => !item.seen).length;
  return (
    <button class="fyi-summary row" type="button" aria-label={`Open FYIs, ${incomplete ? 'at least ' : ''}${unseen} unseen`} onClick={open}>
      <span class="fyi-summary-title">FYI <span class="fyi-count">{unseen}{incomplete ? '+' : ''}</span></span>
      {latest && <span class="fyi-preview">{body(latest) || title(latest)}</span>}
    </button>
  );
}

export function FyiList(p: {
  items: Item[];
  incomplete: boolean;
  session: ClientSession;
  canWrite: boolean;
  attachments: boolean;
  close: () => void;
  openConversation: (key: string) => void;
}) {
  const [posted, setPosted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [marking, setMarking] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const items = [...p.items].sort(posted ? byPosted :
    (a, b) => level(b) - level(a) || (b.message.v2?.score ?? 0) - (a.message.v2?.score ?? 0) || byPosted(a, b));
  const unseen = items.filter((item) => !item.seen);
  const markAll = async () => {
    setMarking(true);
    try {
      for (const item of unseen) await p.session.markFyiSeen(item.message);
    } finally {
      setMarking(false);
    }
  };
  const load = async () => {
    setLoading(true);
    try {
      await p.session.loadAllPages();
    } finally {
      setLoading(false);
    }
  };
  return (
    <main class="fyi-list" aria-labelledby="fyi-title">
      <header class="fyi-toolbar">
        <button type="button" class="btn" onClick={p.close}>Back to Inbox</button>
        <h1 id="fyi-title" tabIndex={-1} ref={heading}>FYI</h1>
        <div class="fyi-toolbar-actions">
          <button type="button" class="btn" aria-pressed={posted} onClick={() => setPosted(!posted)}>
            Sort: {posted ? 'Posted' : 'Priority'}
          </button>
          <button type="button" class="btn" disabled={!p.canWrite || p.incomplete || marking || !unseen.length || unseen.some((item) => item.sending)} onClick={() => void markAll()}>
            Mark All Seen
          </button>
        </div>
      </header>
      {p.incomplete && <button type="button" class="btn" disabled={loading} onClick={() => void load()}>
        {loading ? 'Loading older FYIs…' : 'Load older FYIs'}
      </button>}
      {!items.length && !p.incomplete && <p>No FYIs yet.</p>}
      <ul class="fyi-entries">
        {items.map(({ key, message, seen, sending, failed }) => (
          <li key={key}>
            <article class={`fyi-item type-${messageType(message.payload)}`}>
              <div class="fyi-item-heading">
                <div>
                  <MessageHeading message={message} timestamp={postedAt(message)} />
                </div>
                {seen ? <span class="fyi-seen">Seen</span> : (
                  <button class="btn btn--bordered fyi-seen" type="button" aria-label={`Mark seen: ${title(message)}`} disabled={!p.canWrite || marking || sending} onClick={() => void p.session.markFyiSeen(message)}>
                    {sending ? 'Marking…' : failed ? 'Retry Seen' : 'Seen'}
                  </button>
                )}
              </div>
              <MessageContent message={message} attachments={p.attachments} fileHref={(id) => p.session.fileHref(id)} />
              {message.terminal?.retracted && <p class="msg-note">The sender retracted this message.</p>}
              {message.chat && <button class="btn" type="button" onClick={() => p.openConversation(key)}>Open conversation</button>}
              {failed && !seen && <p role="status">Could not mark this FYI seen.</p>}
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
