import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ClientSession } from '../client';
import { fyiTab, type Tab } from '../state/inbox';
import { body, createdAt, fyiSeen, initials, messageType, senderLabel, title } from '../state/message';
import type { State } from '../state/store';
import type { HeldMessage } from '../state/types';
import { compareCodePoints } from '../v2/model';
import { Icon } from './Icon';
import { MessageContent, MessageHeading } from './MessageContent';

/** One tab's FYIs: Inbox's are not marked Seen, Replied's are. */
export function fyiItems(state: State, tab: Tab) {
  return [...state.messages].flatMap(([key, message]) => {
    if (fyiTab(state, key) !== tab) return [];
    const local = state.answers.get(key);
    return [{
      key,
      message,
      seen: fyiSeen(message),
      sending: local?.state === 'sending',
      failed: !!(local?.seen && local.state === 'failed'),
    }];
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

export function FyiSummary({ tab, items, incomplete, open }: { tab: Tab; items: Item[]; incomplete: boolean; open: () => void }) {
  const unseen = items.length;
  const latest = [...items].sort(byPosted)[0]?.message;
  const sender = latest ? senderLabel(latest) : '';
  return (
    <button class="fyi-summary row" type="button"
      aria-label={tab === 'replied' ? 'Open seen FYIs' : `Open FYIs, ${incomplete ? 'at least ' : ''}${unseen} unseen`}
      aria-describedby={latest ? 'fyi-digest-content' : undefined} onClick={open}>
      <DigestCoast />
      <span class="fyi-digest-text">
        <span class="fyi-summary-title">{tab === 'replied' ? 'Seen FYIs' : <>FYI digest <span class="fyi-count">{unseen}{incomplete ? '+' : ''} unseen</span></>}</span>
        {latest && <span id="fyi-digest-content">
          <strong class="fyi-digest-heading">{title(latest)}</strong>
          {body(latest) && <span class="fyi-preview">{body(latest)}</span>}
          <span class="fyi-digest-agent">
            <span class="initials" aria-hidden="true">{initials(sender)}</span>
            <span>{sender}</span>
          </span>
        </span>}
      </span>
      <span class="fyi-next"><Icon name="fyi-next" /></span>
    </button>
  );
}

function DigestCoast() {
  return (
    <svg class="fyi-coast" viewBox="0 0 250 150" preserveAspectRatio="xMaxYMax slice" aria-hidden="true">
      <defs>
        <pattern id="fyi-sea" width="20" height="7" patternUnits="userSpaceOnUse">
          <path d="M0 1h13" stroke="#9eafb0" opacity=".34" />
        </pattern>
      </defs>
      <path fill="#b9c8bc" opacity=".16" d="M175 45 12 16v25l163 8z" />
      <circle cx="216" cy="29" r="14" fill="none" stroke="#adc1bd" opacity=".44" />
      <path fill="#779197" d="M0 116q42-16 69-8t75-3l32-13 35 2 39-19v75H0z" />
      <path fill="url(#fyi-sea)" d="M0 120q56-15 96-8l154-16v54H0z" />
      <path fill="#253f49" d="m68 150 38-17 17-7 13-17 27-5 12-13 13 2 17-11 23 5 22-10v73z" />
      <g fill="#e4e9d9">
        <path d="m166 101 5-47h9l6 42-9 3z" />
        <path d="M169 50h13v3h-13zm3-10h7v9h-7zm-3-1 6.5-7 6.5 7z" />
      </g>
      <path d="m170 68 11-4 .9 8-13 5z" fill="#506b71" />
    </svg>
  );
}

export function FyiList(p: {
  tab: Tab;
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
  // Before paint, so a key pressed as the list appears is not taken by a later
  // move of focus to the heading.
  useLayoutEffect(() => heading.current?.focus(), []);
  const list = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [p.tab]);
  const items = [...p.items].sort(posted ? byPosted :
    (a, b) => level(b) - level(a) || (b.message.v2?.score ?? 0) - (a.message.v2?.score ?? 0) || byPosted(a, b));
  const unseen = p.tab === 'inbox' ? items : [];
  // Marking one Seen takes it off this list. Focus that was on it goes to the
  // one that took its place, or to the heading.
  const focused = useRef<{ key: string; index: number } | null>(null);
  useLayoutEffect(() => {
    const was = focused.current;
    if (!was || items.some((item) => item.key === was.key)) return;
    focused.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const next = list.current?.querySelectorAll<HTMLElement>('button.fyi-seen:not(:disabled)')[was.index];
    (next ?? heading.current)?.focus();
  });
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
    <main class="fyi-list" aria-labelledby="fyi-title" ref={list}>
      <nav class="fyi-toolbar" aria-label="FYI list controls">
        <button type="button" class="fyi-back" aria-label={`Back to ${p.tab === 'inbox' ? 'Inbox' : 'Replied'}`} onClick={p.close}><Icon name="fyi-back" />{p.tab === 'inbox' ? 'Inbox' : 'Replied'}</button>
        <button type="button" aria-label={posted ? 'Sort: Posted' : 'Sort: Priority'} aria-pressed={posted} onClick={() => setPosted(!posted)}>
          <Icon name="fyi-sort" />{posted ? 'Posted' : 'Priority'}
        </button>
        {p.tab === 'inbox' && (
          <button type="button" disabled={!p.canWrite || p.incomplete || marking || !unseen.length || unseen.some((item) => item.sending)} onClick={() => void markAll()}>
            Mark All Seen
          </button>
        )}
      </nav>
      <header class="fyi-heading">
        <h1 id="fyi-title" tabIndex={-1} ref={heading}>{p.tab === 'inbox' ? 'FYIs' : 'Seen FYIs'}</h1>
        {p.tab === 'inbox' && <span class="fyi-unseen" aria-live="polite">{unseen.length}{p.incomplete ? '+' : ''} unseen</span>}
      </header>
      {p.incomplete && <button type="button" class="btn" disabled={loading} onClick={() => void load()}>
        {loading ? 'Loading older FYIs…' : 'Load older FYIs'}
      </button>}
      {!items.length && !p.incomplete && <p class="fyi-empty">{p.tab === 'inbox' ? 'All FYIs are seen' : 'No seen FYIs yet'}</p>}
      <ul class="fyi-entries">
        {items.map(({ key, message, seen, sending, failed }) => (
          <li key={key} onFocusCapture={() => (focused.current = seen ? null : { key, index: unseen.findIndex((item) => item.key === key) })}>
            <article class={`fyi-item type-${messageType(message.payload)}`}>
              <div class="fyi-item-heading">
                <div>
                  <MessageHeading message={message} timestamp={postedAt(message)}
                    priority={{ now: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }[message.v2?.level ?? 'normal']} />
                </div>
                {seen ? <span class="fyi-seen">Seen</span> : (
                  <button class="btn btn--bordered fyi-seen" type="button" aria-label={`Mark seen: ${title(message)}`} disabled={!p.canWrite || marking || sending} onClick={() => void p.session.markFyiSeen(message)}>
                    <Icon name="row-check" />
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
