import harklightNavy from '../brand/harklight-navy.svg?no-inline';
import harklightMist from '../brand/harklight-mist.svg?no-inline';
import { useEffect, useRef } from 'preact/hooks';
import type { Entry, ListOrder, ReplyRow, Row, Tab } from '../state/inbox';
import { body, friendlyTime, initials, messageType, postedAt, senderLabel, title, TYPE_ICON } from '../state/message';
import { Icon } from './Icon';
import { SortButton } from './SortButton';

export function InboxList(props: {
  tab: Tab;
  order: ListOrder;
  onOrder: (order: ListOrder) => void;
  fyiSummary?: import('preact').ComponentChildren;
  entries: Entry[];
  selected: string | null;
  /** Thread groups the person opened. */
  expanded: Set<string>;
  onToggleThread: (id: string) => void;
  /** The quoted text of a chat reply, if its turn is held. */
  replyText: (key: string, seq: number) => string | null;
  onOpenReply: (r: ReplyRow) => void;
  morePages: boolean;
  unread: (key: string) => boolean;
  seen: (key: string) => boolean;
  needsAnswer: (key: string) => boolean;
  /** A message's submission in flight or failed, shown on its row. */
  submission: (key: string) => 'sending' | 'failed' | null;
  loaded: boolean;
  onTab: (t: Tab) => void;
  onOpen: (key: string) => void;
  onSettings: () => void;
  onNearEnd: () => void;
  phone: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Load older pages while the list does not fill its column (an empty or
  // short tab cannot be scrolled to ask for more).
  useEffect(() => {
    const el = list.current;
    if (el && props.morePages && el.scrollHeight - el.clientHeight < 80) props.onNearEnd();
  });
  const messageRow = (r: Row) => (
    <MessageRow
      key={r.key}
      row={r}
      selected={r.key === props.selected}
      unread={props.unread(r.key)}
      seen={props.seen(r.key)}
      needsAnswer={props.needsAnswer(r.key)}
      tab={props.tab}
      submission={props.submission(r.key)}
      onOpen={props.onOpen}
    />
  );
  const tabs = (
    <div class={props.phone ? 'tabbar' : 'seg'} role="tablist" aria-label="Messages">
      <TabButton tab="inbox" label="Inbox" icon="mail" current={props.tab} onTab={props.onTab} />
      <TabButton tab="replied" label="Replied" icon="mail-open" current={props.tab} onTab={props.onTab} />
    </div>
  );
  return (
    <aside class="side" aria-label="Inbox">
      <div class="side-head">
        <picture>
          <source media="(prefers-color-scheme: light)" srcSet={harklightNavy} />
          <img class="brand" src={harklightMist} width="126" height="30" alt="Harklight" />
        </picture>
        <div class="side-actions">
          <SortButton order={props.order} onOrder={props.onOrder} />
          <button type="button" class="icon-btn" aria-label="Settings" onClick={props.onSettings}>
            <Icon name="gear" />
          </button>
        </div>
      </div>
      {!props.phone && tabs}
      <div
        class="rows"
        ref={list}
        role="tabpanel"
        onScroll={(e) => {
          const el = e.currentTarget as HTMLElement;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) props.onNearEnd();
        }}
      >
        {props.fyiSummary}
        {props.entries.map((e) => {
          if (e.type === 'message') return messageRow(e);
          if (e.type === 'heading')
            return (
              <div key={`h:${e.title}`} class="list-heading">
                <span class="label">{e.title}</span>
                {e.note && <span class="list-note">{e.note}</span>}
              </div>
            );
          if (e.type === 'reply')
            return (
              <ReplyRowView
                key={`r:${e.key}`}
                row={e}
                quote={props.replyText(e.key, e.conversationSeq)}
                onOpen={() => props.onOpenReply(e)}
              />
            );
          const open = props.expanded.has(e.id) || e.members.some((m) => m.key === props.selected);
          return (
            <div key={`t:${e.id}`} class="thread">
              <button type="button" class="thread-head" aria-expanded={open} onClick={() => props.onToggleThread(e.id)}>
                <Icon name="chev" class={open ? 'thread-chev thread-chev--open' : 'thread-chev'} />
                {e.label}
              </button>
              {open && e.members.map(messageRow)}
            </div>
          );
        })}
        {props.loaded && props.entries.length === 0 && !props.morePages && (
          <p class="rows-empty">{props.tab === 'inbox' ? 'No messages' : 'Nothing replied yet'}</p>
        )}
      </div>
      {props.phone && tabs}
    </aside>
  );
}

function TabButton(props: { tab: Tab; label: string; icon: string; current: Tab; onTab: (t: Tab) => void }) {
  const on = props.tab === props.current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      class={on ? 'on' : undefined}
      onClick={() => props.onTab(props.tab)}
    >
      <Icon name={props.icon} />
      {props.label}
    </button>
  );
}

function MessageRow(props: {
  row: Row;
  selected: boolean;
  unread: boolean;
  seen: boolean;
  needsAnswer: boolean;
  tab: Tab;
  submission: 'sending' | 'failed' | null;
  onOpen: (key: string) => void;
}) {
  const { row } = props;
  const m = row.message;
  const type = messageType(m.payload);
  const sender = senderLabel(m);
  const replied = props.tab === 'replied';
  const request = type === 'request';
  const rowIcon = replied ? 'row-check' : request ? 'row-reply' : TYPE_ICON[type];
  const tile = replied ? 'check' : request ? 'request' : null;
  const cls = ['row', `type-${type}`];
  if (row.priority === 'urgent') cls.push('row--urgent');
  else if (row.priority === 'high') cls.push('row--high');
  if (props.selected) cls.push('row--selected');
  if (row.history) cls.push('row--history');
  const meta: string[] = [];
  if (row.priority === 'urgent') meta.push('Urgent');
  if (row.priority === 'high') meta.push('High priority');
  if (row.priority && props.needsAnswer) meta.push('Needs an answer');
  if (m.terminal?.retracted) meta.push('Retracted');
  else if (m.terminal?.state === 'expired') meta.push('Expired');
  else if (m.terminal?.state === 'cleared') meta.push('Cleared');
  return (
    <button
      type="button"
      class={cls.join(' ')}
      aria-current={props.selected ? 'true' : undefined}
      onClick={() => props.onOpen(row.key)}
      data-testid="row"
    >
      <span class="row-head">
        <span class="initials" aria-hidden="true">
          {initials(sender)}
        </span>
        <span class="sender">{sender}</span>
        <span class="time">{friendlyTime(postedAt(m))}</span>
      </span>
      <span class="row-title">
        <span class={tile ? `row-symbol row-tile row-tile--${tile}` : 'row-symbol'}>
          <Icon name={rowIcon} />
        </span>
        <span class="t">{title(m)}</span>
        {props.unread && <Icon name="flag-fill" class="flag flag--unread" />}
        {props.seen && <Icon name="check" class="seen" />}
        {props.submission === 'sending' && <span class="spinner row-spinner" role="img" aria-label="Sending" />}
        {props.submission === 'failed' && (
          <span class="row-failed" role="img" aria-label="Couldn't send">
            <Icon name="alert" />
          </span>
        )}
        {props.unread && <span class="visually-hidden">Unread chat reply</span>}
        {props.seen && <span class="visually-hidden">Seen</span>}
      </span>
      {meta.length > 0 && <span class="row-meta">{meta.join(' · ')}</span>}
      {body(m) && <span class="row-body">{body(m)}</span>}
    </button>
  );
}

/** A chat reply row: the agent answered in a message's chat. */
function ReplyRowView(p: { row: ReplyRow; quote: string | null; onOpen: () => void }) {
  const { row } = p;
  const m = row.message;
  const sender = m ? senderLabel(m) : row.key.split('\u0000')[0];
  const parent = m ? title(m) : row.key.split('\u0000')[1];
  const type = m ? messageType(m.payload) : 'request';
  const cls = ['row', 'row--reply', `type-${type}`];
  if (row.priority === 'urgent') cls.push('row--urgent');
  else if (row.priority === 'high') cls.push('row--high');
  if (row.history) cls.push('row--history');
  const meta: string[] = [];
  if (row.unseen > 1) meta.push(`${row.unseen} new`);
  const prio = row.priority === 'urgent' ? 'Urgent' : row.priority === 'high' ? 'High priority' : null;
  if (prio) meta.push(row.historical ? `Previous priority: ${prio}` : prio);
  return (
    <button type="button" class={cls.join(' ')} onClick={p.onOpen} data-testid="reply-row">
      <span class="row-head">
        <Icon name="row-reply" class="reply-ic" />
        <span class="sender">
          Reply · {sender} · {parent}
        </span>
        {row.postedAt !== null && <time class="time">{friendlyTime(row.postedAt)}</time>}
      </span>
      <span class="row-body reply-quote">{p.quote ?? ''}</span>
      {meta.length > 0 && <span class="row-meta">{meta.join(' · ')}</span>}
    </button>
  );
}
