import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatSend, HeldMessage, PickedFile, Thread } from '../state/types';
import { formatSize } from './format';
import { FileRow } from './FileRow';
import { Icon } from './Icon';
import { NotHanded } from './NotHanded';

export interface ChatProps {
  message: HeldMessage;
  sender: string;
  thread: Thread | undefined;
  sends: ChatSend[];
  open: boolean;
  available: boolean;
  attachments: boolean;
  uploadCap: number | null;
  canSend: boolean;
  /** The account is paused: nothing can be sent or retried until it is back. */
  paused: boolean;
  /** Close the chat (the wide column, or the modal) and return to the message. */
  onClose: () => void;
  /** The wide layout's chat column rather than a modal. */
  column: boolean;
  /** The unsent text and files for this message, kept while the chat is closed. */
  draft: ChatDraft;
  onDraft: (d: ChatDraft) => void;
  onSend: (text: string, files: PickedFile[]) => void;
  onRetry: (opId: string) => void;
  onDiscard?: (opId: string) => void;
  onRemovePendingFile?: (opId: string, fileId: string) => void;
  onReplyVisible: (seq: number) => void;
  fileHref: (uploadId: string) => string;
}

export interface ChatDraft {
  text: string;
  files: PickedFile[];
}

/** The name a picked file goes under: "photo (2).png" when "photo.png" is already in the draft. */
function uniqueName(name: string, taken: PickedFile[]): string {
  const used = new Set(taken.map((x) => x.name));
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function Chat(p: ChatProps) {
  // The draft lives above the chat, per message, so closing the chat (Escape,
  // a click outside) and opening it again brings back what was being written.
  const [text, setTextState] = useState(p.draft.text);
  const [files, setFilesState] = useState<PickedFile[]>(p.draft.files);
  // Saved at once on every change, not in an effect: an effect can be skipped
  // when the chat closes right after a change.
  const draft = useRef<ChatDraft>(p.draft);
  const save = (d: ChatDraft) => {
    draft.current = d;
    p.onDraft(d);
  };
  const setText = (t: string) => {
    setTextState(t);
    save({ ...draft.current, text: t });
  };
  const setFiles = (f: PickedFile[]) => {
    setFilesState(f);
    save({ ...draft.current, files: f });
  };
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const turns = p.thread?.turns ?? [];
  // A send whose turn already shows (lookalike) is hidden until it settles.
  const pending = p.sends.filter((s) => s.key === `${p.message.sender_id}\u0000${p.message.message_id}` && !(s.lookalike && s.state === 'sending'));

  // Keep the newest turn in view as turns arrive.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, pending.length]);

  // Reading an agent reply advances the account's read position (D-5).
  useEffect(() => {
    const el = list.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      for (const t of turns) if (t.kind === 'reply' && t.author !== 'person' && t.seq !== null) p.onReplyVisible(t.seq);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const seq = Number((e.target as HTMLElement).dataset.seq);
          if (Number.isFinite(seq)) p.onReplyVisible(seq);
        }
      },
      { root: el, threshold: 0.5 },
    );
    el.querySelectorAll<HTMLElement>('[data-seq]').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [turns.length, p.onReplyVisible]);

  const availability = p.message.v2?.availability ?? p.thread?.availability ?? null;
  const away = availability === 'not_listening' || availability === 'gone';
  const shown = turns.filter((t) => t.kind === 'discussion' || t.kind === 'reply');
  const empty = shown.length === 0 && pending.length === 0;

  const submit = () => {
    // Read the field itself: a fast Enter can arrive before the re-render.
    const body = field.current?.value ?? text;
    if (!p.canSend || (body.trim() === '' && files.length === 0)) return;
    p.onSend(body, files);
    setText('');
    setFiles([]);
    setError(null);
  };

  const pick = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (p.uploadCap !== null && f.size > p.uploadCap) {
        setError(`${f.name} is larger than the ${formatSize(p.uploadCap)} limit. Nothing was sent.`);
        continue;
      }
      next.push({ id: crypto.randomUUID(), name: uniqueName(f.name, next), size: f.size, file: f });
    }
    setFiles(next);
  };

  return (
    <section class="chat" aria-label="Chat">
      <header class="chat-head">
        <h2 class="chat-title">Chat</h2>
        <button type="button" class="icon-btn" aria-label="Close chat" onClick={p.onClose}>
          <Icon name={p.column ? 'chev' : 'xmark'} />
        </button>
      </header>
      <div class="turns" ref={list}>
        {!p.available && <p class="chat-empty">Chat is not available yet.</p>}
        {p.available && !p.open && (
          <p class="chat-empty">
            <Icon name="chat" />
            {p.sender} did not open a chat for this message.
          </p>
        )}
        {p.available && empty && p.open && (
          <p class="chat-empty">
            <Icon name="chat" />
            Ask {p.sender} about this message.
          </p>
        )}
        {shown.map((t) => {
          const mine = t.author === 'person';
          return (
            <div
              key={t.id}
              class={mine ? 'turn turn--me' : 'turn'}
              data-seq={!mine && t.kind === 'reply' && t.seq !== null ? t.seq : undefined}
            >
              <span class="who">{mine ? 'You' : p.sender}</span>
              <span class="turn-text">{t.text}</span>
              {t.files.map((f, i) => (
                <FileRow key={`${i}\u0000${f.name}`} file={f} download={p.attachments} fileHref={p.fileHref} />
              ))}
              {mine && t.receipt === 'not_handed' && <NotHanded />}
              {mine && t.receipt !== 'not_handed' && (
                <span class="turn-st">
                  {t.receipt === 'delivered' ? (
                    <>
                      <Icon name="check" />
                      Delivered
                    </>
                  ) : (
                    'Sent'
                  )}
                </span>
              )}
            </div>
          );
        })}
        {pending.map((s) => (
          <div key={s.op_id} class="turn turn--me">
            <span class="who">You</span>
            <span class="turn-text">{s.text}</span>
            {s.files.map((f) => (
              <FileRow key={f.id} file={{ name: f.name, size: f.size }} download={false} fileHref={p.fileHref}
                onRemove={s.state === 'failed' && p.onRemovePendingFile ? () => p.onRemovePendingFile?.(s.op_id, f.id) : undefined} />
            ))}
            <span class={s.state === 'failed' ? 'turn-st turn-st--bad' : 'turn-st'}>
              {s.state === 'sending' && 'Sending'}
              {s.state === 'sent' && 'Sent'}
              {s.state === 'closed' && (s.reason === 'unsupported' ? 'Not sent. This message has no chat.' : 'Not sent. This chat is closed.')}
              {s.state === 'failed' && (
                <>
                  <Icon name="warn" />
                  {s.reason?.startsWith('upload_cap_exceeded') ? 'Not sent. A file is over the size limit.' : 'Not sent.'}
                  {p.paused || s.reason === 'inactive_account' ? (
                    ' Messages are paused for this account.'
                  ) : (
                    <button type="button" class="link-btn" onClick={() => p.onRetry(s.op_id)}>
                      Retry
                    </button>
                  )}
                </>
              )}
              {(s.state === 'failed' || s.state === 'closed') && p.onDiscard && (
                <button type="button" class="link-btn" onClick={() => p.onDiscard?.(s.op_id)}>
                  Discard
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {error && (
        <p class="chat-error" role="alert">
          {error}
        </p>
      )}
      {away && (
        <p class="chat-note" data-testid="chat-away">
          {p.sender} isn't listening right now. What you send is kept and delivered when it's back.
        </p>
      )}
      {p.available && p.open && (
        <div class="composer-wrap">
          {files.length > 0 && (
            <div class="pending-files">
              {files.map((f) => (
                <FileRow
                  key={f.id}
                  file={{ name: f.name, size: f.size }}
                  download={false}
                  fileHref={p.fileHref}
                  onRemove={() => setFiles(files.filter((x) => x.id !== f.id))}
                />
              ))}
            </div>
          )}
          <form
            class="composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {p.attachments && (
              <>
                <button
                  type="button"
                  class="square"
                  aria-label="Attach a file"
                  onClick={() => picker.current?.click()}
                >
                  <Icon name="plus" />
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    pick((e.currentTarget as HTMLInputElement).files);
                    (e.currentTarget as HTMLInputElement).value = '';
                  }}
                />
              </>
            )}
            <textarea
              ref={field}
              class="compose-field"
              rows={1}
              placeholder="Write a message…"
              aria-label="Write a message"
              value={text}
              onInput={(e) => {
                const el = e.currentTarget as HTMLTextAreaElement;
                setText(el.value);
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button type="submit" class="square square--send" aria-label="Send message" disabled={!p.canSend || (text.trim() === '' && files.length === 0)}>
              <Icon name="send" />
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
