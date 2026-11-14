import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { Config } from '../config';
import type { RelaySession } from '../relay/session';
import { fileUrl } from '../relay/files';
import { entries as entriesFor, rows as rowsFor, type ReplyRow, type Tab } from '../state/inbox';
import { answerForm, senderLabel } from '../state/message';
import { chatOpen, hasUnread, type State, type Store } from '../state/store';
import type { Json, WireFile } from '../state/types';
import { imageUrlFor } from './images';
import { Chat } from './Chat';
import { Detail, type AnswerChoice } from './Detail';
import { Icon } from './Icon';
import { InboxList } from './InboxList';
import { Settings } from './Settings';

export type Layout = 'wide' | 'medium' | 'phone';

/** Wide starts at about 1,100 (design); one column below 720. */
export const WIDE_MIN = 1100;
export const MEDIUM_MIN = 720;

export function layoutFor(width: number): Layout {
  if (width >= WIDE_MIN) return 'wide';
  if (width >= MEDIUM_MIN) return 'medium';
  return 'phone';
}

function useStore(store: Store): State {
  const [state, setState] = useState(store.state);
  useEffect(() => {
    const off = store.subscribe(() => setState(store.state));
    // Catch anything that changed between the first render and subscribing.
    setState(store.state);
    return off;
  }, [store]);
  return state;
}

function useLayout(): Layout {
  const [layout, setLayout] = useState(() => layoutFor(window.innerWidth));
  useEffect(() => {
    const on = () => setLayout(layoutFor(window.innerWidth));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return layout;
}

type Page = 'inbox' | 'settings';

function pageFromPath(path: string): Page {
  return /\/settings\/?$/.test(path) ? 'settings' : 'inbox';
}

export function App(props: { config: Config; store: Store; session: RelaySession }) {
  const { config, store, session } = props;
  const s = useStore(store);
  const layout = useLayout();
  const [page, setPage] = useState<Page>(() => pageFromPath(location.pathname));
  const [tab, setTab] = useState<Tab>('inbox');
  const [selected, setSelected] = useState<string | null>(null);
  /** Wide: chat column shown unless closed. Medium and phone: chat shown when opened. */
  const [chatShown, setChatShown] = useState(false);
  const [chatHiddenWide, setChatHiddenWide] = useState(false);
  /** Opened from a chat reply row: the open is not reported, as on the phone. */
  const [viaReply, setViaReply] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const on = () => {
      setPage(pageFromPath(location.pathname));
      const st = history.state as { selected?: string | null; chat?: boolean; viaReply?: boolean } | null;
      setSelected(st?.selected ?? null);
      setChatShown(!!st?.chat);
      setViaReply(!!st?.viaReply);
    };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const base = useMemo(() => location.pathname.replace(/\/(inbox|settings)\/?$/, ''), []);
  const go = (p: Page, sel: string | null, chat: boolean, fromReply = false) => {
    history.pushState({ selected: sel, chat, viaReply: fromReply }, '', `${base}/${p}`);
    setPage(p);
    setSelected(sel);
    setChatShown(chat);
    setViaReply(fromReply);
  };

  const listEntries = useMemo(() => entriesFor(s, tab), [s, tab]);
  const rows = useMemo(() => rowsFor(s, tab), [s, tab]);
  const message = selected ? s.messages.get(selected) : undefined;

  // Report the open once the detail is on screen (D-2).
  useEffect(() => {
    if (message && page === 'inbox' && !viaReply) session.messageOpened(message);
  }, [message?.sender_id, message?.message_id, message?.revision, page, s.connection, viaReply]);

  const open = (key: string) => go('inbox', key, false);
  const index = selected ? rows.findIndex((r) => r.key === selected) : -1;
  const thread = selected ? s.threads.get(selected) : undefined;
  const unread = useCallback((k: string) => hasUnread(s, k), [s]);
  const seen = useCallback(
    (k: string) => {
      const m = s.messages.get(k);
      const a = s.answers.get(k);
      return m?.terminal?.outcome?.kind === 'seen' || (!!a?.seen && a.state !== 'failed' && a.state !== 'stale');
    },
    [s],
  );
  const needsAnswer = useCallback(
    (k: string) => {
      const m = s.messages.get(k);
      return !!m && m.terminal === null && answerForm(m.payload).kind !== 'seen';
    },
    [s],
  );

  const onAnswer = (a: AnswerChoice) => {
    if (!message) return;
    if (a.kind === 'no_comment') void session.noComment(message);
    else if (a.kind === 'value') void session.answer(message, a.choice.value as Json, a.choice.label);
    else if (a.kind === 'ui1') void session.answer(message, a.answer as Json, a.summary);
    else void session.answer(message, a.text, a.text);
  };
  // Seen sends JSON null, as the browser contract fixes (D-3).
  const onSeen = () => message && void session.answer(message, null, null, true);

  if (s.connection === 'inactive') return <AccountNotice config={config} />;
  if (page === 'settings') {
    return (
      <Settings
        config={config}
        displayName={s.displayName}
        connection={s.connection}
        onBack={() => go('inbox', selected, false)}
        onSignOut={() => session.stop()}
      />
    );
  }

  const phone = layout === 'phone';
  const chatVisible = message ? (layout === 'wide' ? !chatHiddenWide || chatShown : chatShown) : false;
  const sender = message ? senderLabel(message) : '';
  const fileHref = (id: string) => fileUrl(config.filesPath, id);
  const imageUrl = (f: WireFile) => imageUrlFor(f, config);

  const list = (
    <InboxList
      tab={tab}
      entries={listEntries}
      selected={selected}
      expanded={expanded}
      onToggleThread={(id) => {
        const next = new Set(expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setExpanded(next);
      }}
      replyText={(key, seq) => s.threads.get(key)?.turns.find((t) => t.seq === seq)?.text ?? null}
      onOpenReply={(r: ReplyRow) => {
        setChatHiddenWide(false);
        go('inbox', r.key, true, true);
      }}
      morePages={s.morePages}
      unread={unread}
      seen={seen}
      needsAnswer={needsAnswer}
      loaded={s.loaded}
      onTab={(t) => {
        setTab(t);
        if (!phone) setSelected(null);
      }}
      onOpen={open}
      onSettings={() => go('settings', selected, false)}
      onNearEnd={() => void session.loadMore()}
      phone={phone}
    />
  );

  // Keyed by message and revision: a different message or a new revision
  // starts a fresh draft.
  const detail = message && (
    <Detail
      key={`${selected}\u0000${message.revision}`}
      message={message}
      position={index >= 0 ? { index: index + 1, total: rows.length } : null}
      local={s.answers.get(selected!)}
      unread={unread(selected!)}
      chatButton={!chatVisible}
      phone={phone}
      attachments={config.flags.attachments}
      answerForms={config.flags.answerForms}
      imageUrl={imageUrl}
      canAct={s.connection === 'connected'}
      onPrev={index > 0 ? () => open(rows[index - 1].key) : null}
      onNext={index >= 0 && index < rows.length - 1 ? () => open(rows[index + 1].key) : null}
      onBack={phone ? () => history.back() : null}
      onChat={() => {
        setChatHiddenWide(false);
        go('inbox', selected, true);
      }}
      onAnswer={onAnswer}
      onSeen={onSeen}
      fileHref={fileHref}
    />
  );

  const chat = message && (
    <Chat
      key={selected!}
      message={message}
      sender={sender}
      thread={thread}
      sends={s.chatSends}
      open={chatOpen(thread, message)}
      available={s.chatAvailable}
      attachments={config.flags.attachments}
      uploadCap={s.fileLimits?.cap ?? null}
      canSend={s.connection === 'connected' && chatOpen(thread, message)}
      phone={phone}
      closeLabel={phone ? 'Back to message' : 'Close chat'}
      onClose={() => {
        if (layout === 'wide') setChatHiddenWide(true);
        if (chatShown) history.back();
      }}
      onSend={(text, files) => void session.chat(message, text, files)}
      onRetry={(op) => session.retryChat(op)}
      onReplyVisible={(seq) => session.markRead(selected!, seq)}
      fileHref={fileHref}
    />
  );

  const banner = <ConnectionBanner state={s} />;

  if (phone) {
    return (
      <div class="app app--phone">
        {banner}
        {!message && list}
        {message && !chatShown && detail}
        {message && chatShown && chat}
      </div>
    );
  }

  return (
    <div class={`app app--${layout}${chatVisible ? ' app--chat' : ''}`}>
      {list}
      <div class="main-col">
        {banner}
        {detail ?? (
          <div class="nothing">
            <Icon name="light" />
            <span>Select a message</span>
          </div>
        )}
      </div>
      {chatVisible && <div class={layout === 'medium' ? 'chat-col chat-col--over' : 'chat-col'}>{chat}</div>}
    </div>
  );
}

function ConnectionBanner({ state }: { state: State }) {
  if (state.connection === 'reconnecting')
    return (
      <div class="banner" role="status">
        Reconnecting…
      </div>
    );
  if (state.connection === 'failed')
    return (
      <div class="banner banner--bad" role="alert">
        Harklight could not connect. Reload the page to try again.
      </div>
    );
  return null;
}

/** The Server refused because the account cannot use messaging (B-5a). */
function AccountNotice({ config }: { config: Config }) {
  return (
    <div class="page">
      <main class="page-main notice-page">
        <h1 class="page-title">Messages are paused for this account</h1>
        {config.accountUrl ? (
          <>
            <p>Check your plan on your account page.</p>
            <a class="btn" href={config.accountUrl}>
              Open your account
            </a>
          </>
        ) : (
          <p>Ask the person who runs this Harklight Server.</p>
        )}
      </main>
    </div>
  );
}

/**
 * Shown while the web client is off for customers. Sign-in lands on /inbox,
 * so this leads on to the Devices page rather than ending there.
 */
export function NotYet({ config }: { config: Config }) {
  return (
    <div class="page">
      <main class="page-main notice-page">
        <h1 class="page-title">Web messaging is coming soon</h1>
        <p>For now, read and answer your messages in the Harklight iPhone app.</p>
        {config.devicesPath && (
          <a class="btn" href={config.devicesPath}>
            Go to your devices
          </a>
        )}
      </main>
    </div>
  );
}
