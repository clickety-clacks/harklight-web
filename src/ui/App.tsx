import heronNavy from '../brand/heron-navy.svg?no-inline';
import heronMist from '../brand/heron-mist.svg?no-inline';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Config } from '../config';
import type { ClientSession } from '../client';
import { entries as entriesFor, rows as rowsFor, type ReplyRow, type Tab } from '../state/inbox';
import { answerForm, senderLabel } from '../state/message';
import { chatOpen, hasUnread, type State, type Store } from '../state/store';
import type { Json, WireFile } from '../state/types';
import { imageUrlFor } from './images';
import { Chat, type ChatDraft } from './Chat';
import { Detail, type AnswerChoice } from './Detail';
import { FyiList, FyiSummary, fyiItems } from './FyiList';
import { InboxList } from './InboxList';
import { Settings } from './Settings';

export type Layout = 'wide' | 'medium' | 'phone';

/**
 * Chat is a side panel whenever there is room for it beside the message
 * without squeezing either, and a modal over the message when there isn't.
 * Room means the list, a message column that still reads comfortably (its
 * choice cards and form scenes) and the chat panel, at the accepted design's
 * sizes. 'wide' is that layout.
 */
export const LIST_WIDTH = 340;
export const MESSAGE_MIN = 420;
export const CHAT_PANEL_WIDTH = 340;
export const WIDE_MIN = LIST_WIDTH + MESSAGE_MIN + CHAT_PANEL_WIDTH;
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

export function App(props: { config: Config; store: Store; session: ClientSession }) {
  const { config, store, session } = props;
  const s = useStore(store);
  const layout = useLayout();
  const [page, setPage] = useState<Page>(() => pageFromPath(location.pathname));
  const [tab, setTab] = useState<Tab>('inbox');
  const [showFyi, setShowFyi] = useState(false);
  const restoreFyiFocus = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** Whether the chat is open. Where there's room it shows as a side panel,
   * otherwise as a modal over the message; a resize switches between them and
   * keeps it open. */
  const [chatWanted, setChatWanted] = useState(false);
  /** The person closed the side panel: it stays closed until they open chat. */
  const [panelClosed, setPanelClosed] = useState(false);
  /** The person opened the chat themselves (Chat button, reply row), as opposed
   * to the side panel being open by default. */
  const [chatExplicit, setChatExplicit] = useState(false);
  /** The message whose chat the person has sent in during this visit to it.
   * A visit ends when another message is opened. */
  const sentThisVisit = useRef<string | null>(null);
  const panel = layout === 'wide';
  /** Unsent chat text and files per message, kept while its chat is closed. */
  const drafts = useRef(new Map<string, ChatDraft>());
  /** Close the chat. If opening it was a history step, step back, so the
   * browser's Back and the close control agree; otherwise just close it. */
  const closeChat = () => {
    if ((history.state as { chat?: boolean } | null)?.chat) history.back();
    else setChatWanted(false);
  };
  /** Opened from a chat reply row: the open is not reported, as on the phone. */
  const [viaReply, setViaReply] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const on = () => {
      setPage(pageFromPath(location.pathname));
      const st = history.state as { selected?: string | null; chat?: boolean; viaReply?: boolean; fyi?: boolean } | null;
      if (showFyi && !st?.fyi) restoreFyiFocus.current = true;
      setShowFyi(!!st?.fyi);
      setSelected(st?.selected ?? null);
      setChatWanted(!!st?.chat);
      setChatExplicit(!!st?.chat);
      setViaReply(!!st?.viaReply);
    };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, [showFyi]);

  const base = useMemo(() => location.pathname.replace(/\/(inbox|settings)\/?$/, ''), []);
  const go = (p: Page, sel: string | null, chat: boolean, fromReply = false) => {
    history.pushState({ selected: sel, chat, viaReply: fromReply }, '', `${base}/${p}`);
    setPage(p);
    setShowFyi(false);
    setSelected(sel);
    setChatWanted(chat);
    setChatExplicit(chat);
    setViaReply(fromReply);
  };

  // Where there's room the panel is open by default, unless the person
  // closed it. This also opens it when a resize makes room.
  useEffect(() => {
    if (panel && selected && !panelClosed && !chatWanted) setChatWanted(true);
  }, [panel, selected, panelClosed, chatWanted]);

  // A visit to a message starts when it is opened.
  useEffect(() => {
    if (sentThisVisit.current !== selected) sentThisVisit.current = null;
  }, [selected]);

  // Narrowing below the room for the panel: the chat carries over as a modal
  // only if the person is using it in this visit (opened it themselves, has
  // an unsent draft, or sent in it). An untouched default panel just closes,
  // leaving the message and its Chat button. A half-written message is never
  // lost, since a draft counts. Decided during render, so the modal never
  // mounts for a frame; focus stays on the message.
  const wasPanel = useRef(panel);
  const inUse = !!selected && (chatExplicit || drafts.current.has(selected) || sentThisVisit.current === selected);
  const dropOnNarrow = wasPanel.current && !panel && chatWanted && !inUse;
  useLayoutEffect(() => {
    if (dropOnNarrow) {
      setChatWanted(false);
      if (document.activeElement === document.body || !document.activeElement) {
        document.querySelector<HTMLElement>('.detail .msg-title')?.focus();
      }
    }
    wasPanel.current = panel;
  }, [panel]);

  const groupFyi = !!config.flags.fyiInbox;
  const fyis = useMemo(() => groupFyi ? fyiItems(s) : [], [s, groupFyi]);
  const listEntries = useMemo(() => entriesFor(s, tab, groupFyi), [s, tab, groupFyi]);
  const rows = useMemo(() => rowsFor(s, tab, groupFyi), [s, tab, groupFyi]);
  useEffect(() => {
    if (groupFyi && s.loaded && page === 'inbox') void session.loadAllPages();
  }, [groupFyi, s.loaded, page, session]);
  useLayoutEffect(() => {
    if (!showFyi && restoreFyiFocus.current) {
      restoreFyiFocus.current = false;
      document.querySelector<HTMLElement>('.fyi-summary')?.focus();
    }
  }, [showFyi]);
  const openFyi = () => {
    history.pushState({ fyi: true }, '', location.pathname);
    setSelected(null);
    setShowFyi(true);
  };
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
      return m?.terminal?.outcome?.kind === 'seen' || (!!a?.seen && a.state === 'accepted');
    },
    [s],
  );
  /** A row shows its message's submission while it is in flight or failed. */
  const submission = useCallback(
    (k: string): 'sending' | 'failed' | null => {
      const a = s.answers.get(k);
      const m = s.messages.get(k);
      if (!a || (m && m.terminal)) return null;
      return a.state === 'sending' ? 'sending' : a.state === 'failed' ? 'failed' : null;
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
    else if (a.kind === 'value') void session.answer(message, a.choice.value as Json, a.choice.label, { control: a.choice.id });
    else if (a.kind === 'ui1') void session.answer(message, a.answer as Json, a.summary, { control: 'form', draft: a.draft });
    else void session.answer(message, a.text, a.text, { control: a.choice.id, text: a.text });
  };
  // The session sends the Seen action as a v2 choice.
  const onSeen = () => message && void session.answer(message, null, null, { seen: true, control: 'seen' });
  const onRetry = () => selected && session.retryAnswer(selected);
  const onEdit = () => selected && session.editFailedAnswer(selected);

  const imageUrl = useCallback((f: WireFile) => imageUrlFor(f, (id) => session.pictureBytes(id), s.pictureRetry), [session, s.pictureRetry]);

  // A paused account keeps whatever the tab already holds readable; only when
  // nothing was ever loaded is there nothing to show but the notice.
  if (s.connection === 'inactive' && !s.loaded) return <AccountNotice config={config} />;
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
  const chatVisible = !!message && chatWanted && !dropOnNarrow;
  const sender = message ? senderLabel(message) : '';
  const fileHref = (id: string) => session.fileHref(id);
  const canWrite = session.canWrite(s);

  const list = (
    <InboxList
      tab={tab}
      fyiSummary={groupFyi && (fyis.length > 0 || s.morePages) &&
        <FyiSummary items={fyis} incomplete={s.morePages} open={openFyi} />}
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
        // The message first, then its chat over it, so closing the chat
        // returns to the message.
        setPanelClosed(false);
        go('inbox', r.key, false, true);
        go('inbox', r.key, true, true);
      }}
      morePages={s.morePages}
      unread={unread}
      seen={seen}
      needsAnswer={needsAnswer}
      submission={submission}
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
      chatButton={!panel || !chatVisible}
      phone={phone}
      attachments={config.flags.attachments}
      answerForms={config.flags.answerForms}
      ui1Limits={s.fileLimits?.ui1}
      imageUrl={imageUrl}
      canAct={canWrite}
      onPrev={index > 0 ? () => open(rows[index - 1].key) : null}
      onNext={index >= 0 && index < rows.length - 1 ? () => open(rows[index + 1].key) : null}
      onBack={phone ? () => history.back() : null}
      onChat={() => {
        setPanelClosed(false);
        go('inbox', selected, true, viaReply);
      }}
      onAnswer={onAnswer}
      onSeen={onSeen}
      onRetry={onRetry}
      onEdit={onEdit}
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
      canSend={canWrite && chatOpen(thread, message)}
      paused={s.connection === 'inactive'}
      column={panel}
      draft={drafts.current.get(selected!) ?? { text: '', files: [] }}
      onDraft={(d) => {
        if (d.text === '' && d.files.length === 0) drafts.current.delete(selected!);
        else drafts.current.set(selected!, d);
      }}
      onClose={() => {
        if (panel) setPanelClosed(true);
        closeChat();
      }}
      onSend={(text, files) => {
        sentThisVisit.current = selected;
        void session.chat(message, text, files);
      }}
      onRetry={(op) => session.retryChat(op)}
      onDiscard={(op) => session.discardChat(op)}
      onRemovePendingFile={session.removeChatFile ? (op, file) => session.removeChatFile?.(op, file) : undefined}
      onReplyVisible={(seq) => session.markRead(selected!, seq)}
      fileHref={fileHref}
    />
  );

  const banner = <ConnectionBanner state={s} config={config} onTryAgain={() => session.tryAgain()} />;

  if (groupFyi && showFyi) return (
    <div class="app app--phone">
      {banner}
      <FyiList items={fyis} incomplete={s.morePages} session={session} canWrite={canWrite}
        attachments={config.flags.attachments} close={() => history.back()}
        openConversation={(key) => go('inbox', key, true, true)} />
    </div>
  );

  const modal = chatVisible && !panel && (
    <ChatModal label={`Chat with ${sender}`} phone={phone} onClose={closeChat}>
      {chat}
    </ChatModal>
  );

  if (phone) {
    return (
      <div class="app app--phone">
        {banner}
        {!message && list}
        {message && detail}
        {modal}
      </div>
    );
  }

  return (
    <div class={`app app--${layout}${chatVisible && panel ? ' app--chat' : ''}`}>
      {list}
      <div class="main-col">
        {banner}
        {detail ?? (
          <div class="nothing">
            <picture>
              <source media="(prefers-color-scheme: light)" srcSet={heronNavy} />
              <img src={heronMist} width="44" height="44" alt="" />
            </picture>
            <span>Select a message</span>
          </div>
        )}
      </div>
      {chatVisible && panel && <div class="chat-col">{chat}</div>}
      {modal}
    </div>
  );
}

/**
 * Chat as a modal layer over its message, when there's no room for the side
 * panel: a native modal dialog, so the page under
 * it is inert, focus moves into it, Escape closes it, and screen readers
 * announce a dialog. Focus returns to whatever opened it when it closes.
 */
function ChatModal(p: { label: string; phone: boolean; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Close once through the app, however the close came: Escape (cancel), a
  // click outside, or the browser closing the dialog itself without a
  // cancelable cancel event.
  const closing = useRef(false);
  const requestClose = () => {
    if (closing.current) return;
    closing.current = true;
    p.onClose();
  };
  // A layout effect, so focus is back on the opener in the same step the
  // dialog closes, never left on the page body in between.
  useLayoutEffect(() => {
    const d = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    return () => {
      closing.current = true;
      if (d?.open) d.close();
      // Back to whatever opened it. Focus it now, so focus never rests on the
      // page body, then check once the update has finished: if the opener has
      // gone (a widening window turned the modal into the side panel and the
      // Chat button is no longer shown), move focus into the chat panel, or
      // else to the message.
      if (opener && opener.isConnected) opener.focus();
      queueMicrotask(() => {
        if (opener && opener.isConnected && opener.offsetParent !== null) {
          if (document.activeElement !== opener) opener.focus();
          return;
        }
        // The message now, then the chat panel once it has been drawn.
        document.querySelector<HTMLElement>('.detail .msg-title')?.focus();
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('.chat-col .compose-field:not(:disabled), .chat-col .chat-head button')?.focus(),
        );
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      class={p.phone ? 'chat-modal chat-modal--phone' : 'chat-modal'}
      aria-label={p.label}
      onCancel={(e) => {
        // Escape: close through the app, so history and state follow.
        e.preventDefault();
        requestClose();
      }}
      onClose={requestClose}
      onClick={(e) => {
        // A click on the backdrop (outside the panel) closes it.
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      {p.children}
    </dialog>
  );
}

function ConnectionBanner({ state, config, onTryAgain }: { state: State; config: Config; onTryAgain: () => void }) {
  if (state.connection === 'inactive')
    return (
      <div class="banner banner--bad" role="status">
        Messages are paused for this account.{' '}
        {config.accountUrl ? (
          <a href={config.accountUrl}>Open your account</a>
        ) : (
          'Ask the person who runs this Harklight Server.'
        )}
      </div>
    );
  if (state.internalError) {
    const { op, status, token, requestId } = state.internalError;
    const details = [
      `Operation: ${op}`,
      `Error: ${token}`,
      ...(status === null ? [] : [`HTTP status: ${status}`]),
      `Request-Id: ${requestId ?? (op === 'feed' ? 'unavailable (SSE closing carries none)' : 'unavailable')}`,
    ].join('\n');
    const failed = state.connection === 'failed';
    const canRetry = failed || ['inbox', 'entries', 'read_position', 'file_preview'].includes(op);
    return (
      <div class="banner banner--bad" role="alert">
        {failed && state.loaded ? 'Live updates paused.' : 'Harklight Server could not finish the request.'}{' '}
        <button type="button" class="tool tool--inline" onClick={() => void navigator.clipboard.writeText(details).catch(() => undefined)}>
          Copy details
        </button>{' '}
        {canRetry && <button type="button" class="tool tool--inline" onClick={onTryAgain}>Try again</button>}
      </div>
    );
  }
  if (state.connection === 'reconnecting')
    return (
      <div class="banner" role="status">
        Reconnecting…
      </div>
    );
  if (state.connection === 'failed')
    return (
      <div class="banner banner--bad" role="alert">
        Harklight could not connect.{' '}
        <button type="button" class="tool tool--inline" onClick={onTryAgain}>
          Try again
        </button>
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
