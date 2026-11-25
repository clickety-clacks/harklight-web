import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ClientSession } from '../client';
import { fyiTab, type ListOrder, type Tab } from '../state/inbox';
import { body, fyiSeen, friendlyTime, initials, messageType, postedAt, senderLabel, title, TYPE_ICON } from '../state/message';
import type { State } from '../state/store';
import { compareCodePoints } from '../v2/model';
import { Icon } from './Icon';
import { SortButton } from './SortButton';

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

type Item = ReturnType<typeof fyiItems>[number];
const byPosted = (a: Item, b: Item) =>
  (postedAt(b.message) ?? -Infinity) - (postedAt(a.message) ?? -Infinity) || compareCodePoints(a.key, b.key);
const priority = { now: 3, high: 2, normal: 1, low: 0 } as const;
const level = (item: Item) => priority[item.message.v2?.level ?? 'normal'];

export function FyiSummary({ tab, items, incomplete, open }: { tab: Tab; items: Item[]; incomplete: boolean; open: () => void }) {
  const unseen = items.length;
  const latest = [...items].sort(byPosted)[0]?.message;
  return (
    <button class="fyi-summary row" type="button"
      aria-label={tab === 'replied' ? 'Open seen FYIs' : `Open FYIs, ${incomplete ? 'at least ' : ''}${unseen} unseen`}
      aria-describedby={latest ? 'fyi-digest-content' : undefined} onClick={open}>
      <span class="fyi-digest-text">
        <span class="fyi-summary-title">{tab === 'replied' ? 'Seen FYIs' : <>FYI digest <span class="fyi-count">{unseen}{incomplete ? '+' : ''} unseen</span></>}</span>
        {latest && <span id="fyi-digest-content">
          <strong class="fyi-digest-heading">{title(latest)}</strong>
          {body(latest) && <span class="fyi-preview">{body(latest)}</span>}
        </span>}
      </span>
      <span class="fyi-next"><Icon name="fyi-next" /></span>
    </button>
  );
}

export interface FyiListMemory {
  order: ListOrder;
  opener: { tab: Tab; key: string; scrollTop: number } | null;
}

export function FyiList(p: {
  tab: Tab;
  items: Item[];
  incomplete: boolean;
  session: ClientSession;
  canWrite: boolean;
  active: boolean;
  memory: FyiListMemory;
  close: () => void;
  openMessage: (key: string) => void;
}) {
  const [order, setOrder] = useState(p.memory.order);
  const [loading, setLoading] = useState(false);
  const [marking, setMarking] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [p.tab]);
  useLayoutEffect(() => {
    if (!p.active) return;
    const previous = p.memory.opener;
    let opener: HTMLButtonElement | undefined;
    if (previous?.tab === p.tab && list.current) {
      list.current.scrollTop = previous.scrollTop;
      opener = Array.from(list.current.querySelectorAll<HTMLButtonElement>('.fyi-open'))
        .find((button) => button.dataset.fyiKey === previous.key);
    }
    // When Seen removed the row, the heading is the next stable focus target.
    (opener ?? heading.current)?.focus({ preventScroll: true });
  }, [p.active]);
  const items = [...p.items].sort(order === 'posted' ? byPosted :
    (a, b) => level(b) - level(a) || (b.message.v2?.score ?? 0) - (a.message.v2?.score ?? 0) || byPosted(a, b));
  const unseen = p.tab === 'inbox' ? items : [];
  // Marking one Seen takes it off this list. Focus that was on it goes to the
  // one that took its place, or to the heading.
  const focused = useRef<{ key: string; index: number } | null>(null);
  useLayoutEffect(() => {
    const was = focused.current;
    if (!p.active || !was || items.some((item) => item.key === was.key)) return;
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
    <main class="fyi-list" aria-labelledby="fyi-title" ref={list} hidden={!p.active}>
      <nav class="fyi-toolbar" aria-label="FYI list controls">
        <button type="button" class="fyi-back" aria-label={`Back to ${p.tab === 'inbox' ? 'Inbox' : 'Replied'}`} onClick={p.close}>
          <Icon name="fyi-back" />
        </button>
        <h1 id="fyi-title" tabIndex={-1} ref={heading}>{p.tab === 'inbox' ? 'FYIs' : 'Seen FYIs'}</h1>
        <SortButton order={order} onOrder={(next) => {
          p.memory.order = next;
          setOrder(next);
        }} />
        {p.tab === 'inbox' && (
          <button type="button" disabled={!p.canWrite || p.incomplete || marking || !unseen.length || unseen.some((item) => item.sending)} onClick={() => void markAll()}>
            Mark All Seen
          </button>
        )}
      </nav>
      {p.tab === 'inbox' && <p class="fyi-unseen" aria-live="polite">{unseen.length}{p.incomplete ? '+' : ''} unseen</p>}
      {p.incomplete && <button type="button" class="btn" disabled={loading} onClick={() => void load()}>
        {loading ? 'Loading older FYIs…' : 'Load older FYIs'}
      </button>}
      {!items.length && !p.incomplete && <p class="fyi-empty">{p.tab === 'inbox' ? 'All FYIs are seen' : 'No seen FYIs yet'}</p>}
      <ul class="fyi-entries">
        {items.map(({ key, message, seen, sending, failed }) => (
          <li key={key}>
            <article class={`fyi-item type-${messageType(message.payload)}`}>
              <div class="fyi-item-heading">
                <button type="button" class="fyi-open" aria-label={title(message)} data-fyi-key={key}
                  onClick={() => {
                    focused.current = null;
                    p.memory.opener = { tab: p.tab, key, scrollTop: list.current?.scrollTop ?? 0 };
                    p.openMessage(key);
                  }}>
                  <span class="row-head">
                    <span class="initials" aria-hidden="true">{initials(senderLabel(message))}</span>
                    <span class="sender">{senderLabel(message)}</span>
                    <time class="time">{friendlyTime(postedAt(message))}</time>
                  </span>
                  <span class="row-title">
                    <span class="row-symbol"><Icon name={TYPE_ICON[messageType(message.payload)]} /></span>
                    <span class="t">{title(message)}</span>
                  </span>
                  {(message.v2?.level === 'now' || message.v2?.level === 'high') && (
                    <span class="row-meta">{message.v2.level === 'now' ? 'Urgent' : 'High priority'}</span>
                  )}
                  {body(message) && <span class="row-body">{body(message)}</span>}
                </button>
                {seen ? <span class="fyi-seen">Seen</span> : (
                  <button class="btn btn--bordered fyi-seen" type="button" aria-label={`Mark seen: ${title(message)}`} disabled={!p.canWrite || marking || sending}
                    onFocus={() => (focused.current = { key, index: unseen.findIndex((item) => item.key === key) })} onClick={() => void p.session.markFyiSeen(message)}>
                    <Icon name="row-check" />
                    {sending ? 'Marking…' : failed ? 'Retry Seen' : 'Seen'}
                  </button>
                )}
              </div>
              {failed && !seen && <p role="status">Could not mark this FYI seen.</p>}
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
