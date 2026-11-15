import { useState } from 'preact/hooks';
import {
  answerForm,
  answeredText,
  body,
  createdAt,
  friendlyTime,
  initials,
  messageType,
  senderLabel,
  title,
  TYPE_ICON,
  type Choice,
} from '../state/message';
import type { LocalAnswer } from '../state/store';
import type { HeldMessage, Json, WireFile } from '../state/types';
import { compose, emptyDraft, summarize, terminalScene, type Draft } from '../ui1/form';
import { Scene } from '../ui1/Ui1Form';
import { FileRow } from './FileRow';
import { Icon } from './Icon';

export type AnswerChoice =
  | { kind: 'value'; choice: Choice }
  | { kind: 'text'; choice: Choice; text: string }
  | { kind: 'no_comment' }
  | { kind: 'ui1'; answer: unknown; summary: string; draft: Draft };

export interface DetailProps {
  message: HeldMessage;
  position: { index: number; total: number } | null;
  local: LocalAnswer | undefined;
  unread: boolean;
  /** Show the chat button in the bar (chat is not already on screen). */
  chatButton: boolean;
  phone: boolean;
  attachments: boolean;
  /** Draw custom answer forms (attention-client.ui/1). */
  answerForms: boolean;
  imageUrl: (f: WireFile) => Promise<string | null>;
  canAct: boolean;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onBack: (() => void) | null;
  onChat: () => void;
  onAnswer: (a: AnswerChoice) => void;
  onSeen: (value: Json) => void;
  /** Send the failed submission again, unchanged. */
  onRetry: () => void;
  /** Turn a failed written answer back into a draft; the next send is new. */
  onEdit: () => void;
  fileHref: (uploadId: string) => string;
}

export function Detail(p: DetailProps) {
  const m = p.message;
  const type = messageType(m.payload);
  const form = answerForm(m.payload, { enabled: p.answerForms, fileNames: m.firstFiles.map((f) => f.name) });
  const sender = senderLabel(m);
  // A failed or sending written answer reopens as it was sent, so its text
  // and its Retry survive leaving the message and coming back.
  const held = p.local && (p.local.state === 'failed' || p.local.state === 'sending') ? p.local : null;
  const [picked, setPicked] = useState<string | null>(() => (held && held.text !== undefined ? held.control : null));
  const [text, setText] = useState(() => held?.text ?? '');
  const [draft, setDraft] = useState<Draft>(() => (held?.control === 'form' && held.draft ? (held.draft as Draft) : emptyDraft()));
  const [formError, setFormError] = useState<string | null>(null);

  // The control the person tapped carries the submission's state: a spinner
  // while sending, its done state once the Server confirms, or the failure mark with
  // Retry. No status lines.
  const local = p.local;
  const sending = local?.state === 'sending';
  const failed = local?.state === 'failed';
  const seenDone = m.terminal?.outcome?.kind === 'seen' || (!!local?.seen && local.state === 'accepted');
  const answered =
    !seenDone &&
    (m.terminal?.state === 'answered' ||
      m.terminal?.state === 'no_comment' ||
      (!!local && !local.seen && local.state === 'accepted'));
  const open = m.terminal === null && !answered && !seenDone;
  const canAnswer = open && p.canAct && !sending;
  const control = sending || failed ? local!.control : null;
  const statusOf = (id: string): Status => (control === id ? (sending ? 'sending' : 'failed') : null);

  const choices = form.kind === 'choices' ? form.choices : [];
  const replyFailed = failed && choices.some((c) => c.kind === 'text' && c.id === control);
  const formFailed = failed && control === 'form';
  // A failed written answer is held exactly as sent: Retry resends it, and
  // Edit turns it back into a draft whose send is a new answer.
  const replyFrozen = replyFailed && picked === control;
  const formFrozen = formFailed && picked !== 'no_comment';
  const barRetry = replyFrozen || formFrozen;
  // A picked choice carries its own spinner and the checkmark is only disabled;
  // a written reply or a form has no control of its own, so the checkmark spins.
  const barSpins = sending && (control === 'form' || choices.some((c) => c.kind === 'text' && c.id === control));
  const pickedChoice = choices.find((c) => c.id === picked) ?? null;
  // A custom form's checkmark stays on while the message is open; what is
  // missing is said when it is pressed, as on the phone.
  const ready =
    picked === 'no_comment' ||
    form.kind === 'ui1' ||
    (pickedChoice !== null && (pickedChoice.kind === 'value' || text.trim() !== ''));

  const commit = () => {
    // A locked failed answer goes out only through Retry, or as a new send after Edit.
    if (!ready || !canAnswer || barRetry) return;
    if (picked === 'no_comment') p.onAnswer({ kind: 'no_comment' });
    else if (form.kind === 'ui1') {
      const c = compose(form.doc, draft);
      if (!c.ok) {
        setFormError(
          c.reason === 'incomplete'
            ? 'Complete the response before sending your answer.'
            : 'This answer is too large to send.',
        );
        return;
      }
      setFormError(null);
      p.onAnswer({ kind: 'ui1', answer: c.answer, summary: summarize(form.doc, draft), draft });
    } else if (pickedChoice?.kind === 'value') p.onAnswer({ kind: 'value', choice: pickedChoice });
    else if (pickedChoice) {
      // Read the field itself: a fast send can arrive before the re-render.
      const typed = document.querySelector<HTMLTextAreaElement>('.rc-pane')?.value ?? text;
      if (typed.trim() !== '') p.onAnswer({ kind: 'text', choice: pickedChoice, text: typed });
    }
  };

  const isSeenForm = form.kind === 'seen';
  const writing = pickedChoice?.kind === 'text';

  return (
    <section class={`detail type-${type}`} aria-label={title(m)}>
      <div class="detail-bar">
        <div class="bar-group">
          {p.onBack && (
            <button type="button" class="tool tool--square" aria-label="Back to inbox" onClick={p.onBack}>
              <Icon name="back" />
            </button>
          )}
          {!p.phone && (
            <button
              type="button"
              class="tool tool--square"
              aria-label="Previous message"
              disabled={!p.onPrev}
              onClick={() => p.onPrev?.()}
            >
              <Icon name="back" />
            </button>
          )}
          {p.position && (
            <span class="tool tool--static" aria-label={`Message ${p.position.index} of ${p.position.total}`}>
              {p.position.index} of {p.position.total}
            </span>
          )}
          {!p.phone && (
            <button
              type="button"
              class="tool tool--square"
              aria-label="Next message"
              disabled={!p.onNext}
              onClick={() => p.onNext?.()}
            >
              <Icon name="chev" />
            </button>
          )}
        </div>
        <div class="bar-group">
          {p.chatButton && !p.phone && <ChatButton unread={p.unread} onChat={p.onChat} />}
          {open && formFrozen && (
            <button type="button" class="tool" onClick={p.onEdit}>
              Edit
            </button>
          )}
          {open && !isSeenForm && form.kind !== 'unsupported' && barRetry && (
            <button
              type="button"
              class="tool tool--retry"
              data-testid={formFrozen ? 'form-failed' : undefined}
              onClick={p.onRetry}
              disabled={!p.canAct}
            >
              {formFrozen && <FailMark />}
              Retry
            </button>
          )}
          {open && !isSeenForm && form.kind !== 'unsupported' && !barRetry && (
            <button
              type="button"
              class={barSpins ? 'tool tool--square tool--commit tool--busy' : 'tool tool--square tool--commit'}
              aria-label={barSpins ? 'Sending' : form.kind === 'ui1' ? String((form.doc.submission as Record<string, unknown>).label) : 'Send answer'}
              disabled={!ready || !canAnswer}
              onClick={commit}
            >
              {barSpins ? <span class="spinner" aria-hidden="true" /> : <Icon name="check" />}
            </button>
          )}
          {open && form.kind === 'unsupported' && picked === 'no_comment' && (
            <button type="button" class="tool tool--square tool--commit" aria-label="Send answer" disabled={!canAnswer} onClick={commit}>
              <Icon name="check" />
            </button>
          )}
          {open && isSeenForm && (
            <SeenButton
              status={statusOf('seen')}
              bar
              disabled={!canAnswer && !failed}
              onSeen={() => form.kind === 'seen' && p.onSeen(form.value)}
              onRetry={p.onRetry}
            />
          )}
        </div>
      </div>
      <div class="detail-scroll">
        <div class="detail-body">
          <div class="msg-head">
            <span class="initials" aria-hidden="true">
              {initials(sender)}
            </span>
            <span>
              {sender}
              {createdAt(m) !== null && ` · ${friendlyLong(createdAt(m)!)}`}
            </span>
          </div>
          <h2 class="msg-title">
            <Icon name={TYPE_ICON[type]} />
            <span>{title(m)}</span>
          </h2>
          {body(m) && <p class="msg-body">{body(m)}</p>}
          {m.files.length > 0 && (
            <div class="files">
              {m.files.map((f) => (
                <FileRow key={f.name} file={f} download={p.attachments} fileHref={p.fileHref} />
              ))}
            </div>
          )}

          {m.terminal?.retracted && <p class="msg-note">The sender retracted this message.</p>}
          {!m.terminal?.retracted && m.terminal?.state === 'expired' && !answered && !seenDone && (
            <p class="msg-note">This message expired.</p>
          )}
          {!m.terminal?.retracted && m.terminal?.state === 'cleared' && !answered && !seenDone && (
            <p class="msg-note">This message was cleared.</p>
          )}

          {answered && (
            <AnsweredCard
              text={
                m.terminal?.state === 'no_comment' || local?.noComment
                  ? 'No comment'
                  : (answeredText(m, local?.label ?? null) ?? 'Answered')
              }
            />
          )}
          {seenDone && (
            <span class="tool tool--seen seen-under seen-done" data-testid="seen-done">
              <Icon name="check" />
              Seen
            </span>
          )}

          {open && isSeenForm && (
            <SeenButton
              status={statusOf('seen')}
              disabled={!canAnswer && !failed}
              onSeen={() => form.kind === 'seen' && p.onSeen(form.value)}
              onRetry={p.onRetry}
            />
          )}

          {open && form.kind === 'choices' && (
            <div class="choices" role="radiogroup" aria-label="Answer">
              {choices.map((c) =>
                c.kind === 'text' ? (
                  <ReplyCard
                    key={c.id}
                    choice={c}
                    on={picked === c.id}
                    text={text}
                    status={statusOf(c.id)}
                    dim={sending && control !== c.id}
                    disabled={!canAnswer}
                    frozen={replyFrozen && control === c.id}
                    onPick={() => setPicked(c.id)}
                    onText={setText}
                    onSubmit={commit}
                    onEdit={p.onEdit}
                  />
                ) : (
                  <ChoiceCard
                    key={c.id}
                    choice={c}
                    on={picked === c.id}
                    compact={writing}
                    status={statusOf(c.id)}
                    dim={sending && control !== c.id}
                    disabled={!canAnswer}
                    onPick={() => setPicked(c.id)}
                    onRetry={p.onRetry}
                  />
                ),
              )}
              <ChoiceCard
                choice={{ id: 'no_comment', label: 'No comment', kind: 'value', suggested: false }}
                on={picked === 'no_comment'}
                compact={writing}
                status={statusOf('no_comment')}
                dim={sending && control !== 'no_comment'}
                disabled={!canAnswer}
                onPick={() => setPicked('no_comment')}
                onRetry={p.onRetry}
              />
            </div>
          )}
          {open && form.kind === 'ui1' && (
            <div class="u-form">
              <Scene
                node={form.doc.open as Record<string, unknown>}
                ctx={{
                  doc: form.doc,
                  draft,
                  onDraft: canAnswer && !formFrozen
                    ? (d) => {
                        setDraft(d);
                        if (picked === 'no_comment') setPicked(null);
                      }
                    : null,
                  files: m.firstFiles,
                  imageUrl: p.imageUrl,
                }}
              />
              <div class="choices" role="radiogroup" aria-label="No comment">
                <ChoiceCard
                  choice={{ id: 'no_comment', label: 'No comment', kind: 'value', suggested: false }}
                  on={picked === 'no_comment'}
                  compact={false}
                  status={statusOf('no_comment')}
                  dim={sending && control !== 'no_comment'}
                  disabled={!canAnswer}
                  onRetry={p.onRetry}
                  onPick={() => {
                    setPicked('no_comment');
                    setDraft({ ...draft, selected: {} });
                  }}
                />
              </div>
              {formError && (
                <p class="msg-note msg-note--bad" role="alert">
                  {formError}
                </p>
              )}
            </div>
          )}
          {/* A closed custom form shows its declared closing scene, under the
              Answered or No comment card when there is one. */}
          {form.kind === 'ui1' && (m.terminal || answered) && !seenDone && !m.terminal?.retracted && (
            <div class="u-form">
              <Scene
                node={terminalScene(form.doc, m.terminal?.state ?? (local?.noComment ? 'no_comment' : 'answered'))}
                ctx={{ doc: form.doc, draft: emptyDraft(), onDraft: null, files: m.firstFiles, imageUrl: p.imageUrl }}
              />
            </div>
          )}
          {open && form.kind === 'unsupported' && (
            <>
              <p class="msg-note">This message uses an answer format the web client cannot show yet. Answer it on your iPhone.</p>
              <div class="choices" role="radiogroup" aria-label="Answer">
                <ChoiceCard
                  choice={{ id: 'no_comment', label: 'No comment', kind: 'value', suggested: false }}
                  on={picked === 'no_comment'}
                  compact={false}
                  status={statusOf('no_comment')}
                  disabled={!canAnswer}
                  onPick={() => setPicked('no_comment')}
                  onRetry={p.onRetry}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {p.phone && p.chatButton && (
        <div class="fab">
          <ChatButton unread={p.unread} onChat={p.onChat} />
        </div>
      )}
    </section>
  );
}

function friendlyLong(ms: number): string {
  const short = friendlyTime(ms);
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today, ${short}`;
  return short;
}

export function ChatButton(p: { unread: boolean; onChat: () => void }) {
  return (
    <button type="button" class="tool tool--square" aria-label={p.unread ? 'Chat, unread reply' : 'Chat'} onClick={p.onChat}>
      <Icon name="chat" />
      {p.unread && (
        <span class="badge" aria-hidden="true">
          1
        </span>
      )}
    </button>
  );
}

type Status = 'sending' | 'failed' | null;

function ChoiceCard(p: {
  choice: Choice;
  on: boolean;
  compact: boolean;
  status: Status;
  /** Another control is sending: this one steps back. */
  dim?: boolean;
  disabled: boolean;
  onPick: () => void;
  onRetry: () => void;
}) {
  const c = p.choice;
  const label = (
    <span class="ti">
      {c.label}
      {c.suggested && <span class="sug">Suggested</span>}
    </span>
  );
  if (p.status === 'failed') {
    return (
      <div class="choice choice--failed" data-testid="choice-failed">
        <FailMark />
        <span class="choice-text">{label}</span>
        <button type="button" class="tool tool--retry tool--inline" onClick={p.onRetry}>
          Retry
        </button>
      </div>
    );
  }
  const cls = ['choice'];
  if (p.on || p.status === 'sending') cls.push('choice--on');
  if (p.status === 'sending') cls.push('choice--sending');
  if (p.dim) cls.push('choice--dim');
  return (
    <button
      type="button"
      role="radio"
      aria-checked={p.on}
      aria-busy={p.status === 'sending' || undefined}
      class={cls.join(' ')}
      disabled={p.disabled}
      onClick={p.onPick}
    >
      {p.status === 'sending' ? <span class="spinner mark-spinner" aria-label="Sending" role="img" /> : <span class="mark" aria-hidden="true" />}
      <span class="choice-text">
        {label}
        {!p.compact && c.description && <span class="de">{c.description}</span>}
      </span>
    </button>
  );
}

function ReplyCard(p: {
  choice: Choice;
  on: boolean;
  text: string;
  status: Status;
  dim?: boolean;
  disabled: boolean;
  /** Failed and held as sent: the text is read-only until Edit. */
  frozen: boolean;
  onPick: () => void;
  onText: (t: string) => void;
  onSubmit: () => void;
  onEdit: () => void;
}) {
  const cls = ['replycard'];
  if (p.on) cls.push('replycard--on');
  if (p.status === 'sending') cls.push('replycard--sending');
  if (p.status === 'failed') cls.push('replycard--failed');
  if (p.dim) cls.push('choice--dim');
  return (
    <div class={cls.join(' ')} data-testid={p.status === 'failed' ? 'reply-failed' : undefined}>
      <button
        type="button"
        role="radio"
        aria-checked={p.on}
        class="rc-head"
        aria-label={p.status === 'failed' ? p.choice.label : undefined}
        disabled={p.disabled}
        onClick={p.onPick}
      >
        {p.status === 'failed' ? <FailMark /> : <span class="mark" aria-hidden="true" />}
        {p.status !== 'failed' && <span class="ti">{p.choice.label}</span>}
      </button>
      {p.frozen && (
        <button type="button" class="tool tool--inline rc-edit" onClick={p.onEdit}>
          Edit
        </button>
      )}
      {p.on && (
        <textarea
          class="rc-pane"
          aria-label={p.choice.label}
          value={p.text}
          disabled={p.disabled}
          readOnly={p.frozen}
          ref={(el) => {
            if (el && document.activeElement !== el && !p.text) el.focus();
          }}
          onInput={(e) => p.onText((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              p.onSubmit();
            }
          }}
        />
      )}
    </div>
  );
}

/** Seen, in the bar and under the text: it spins while sending and comes back
 * as Retry Seen if the send fails. */
function SeenButton(p: { status: Status; bar?: boolean; disabled: boolean; onSeen: () => void; onRetry: () => void }) {
  if (p.status === 'failed') {
    return (
      <button type="button" class={p.bar ? 'tool tool--retry' : 'tool tool--retry seen-under'} onClick={p.onRetry}>
        <FailMark />
        Retry Seen
      </button>
    );
  }
  const busy = p.status === 'sending';
  return (
    <button
      type="button"
      class={p.bar ? 'tool tool--seen' : 'tool seen-under'}
      aria-busy={busy || undefined}
      disabled={p.disabled || busy}
      onClick={p.onSeen}
    >
      {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name={p.bar ? 'check' : 'eye'} />}
      Seen
    </button>
  );
}

/** A confirmed answer: the check and what was answered, with no heading. */
function AnsweredCard(p: { text: string }) {
  return (
    <div class="answered" data-testid="answered">
      <Icon name="check" />
      <div class="an-text">{p.text}</div>
    </div>
  );
}

/** The failure mark: a circled exclamation, named for screen readers. */
function FailMark() {
  return (
    <span class="fail-mark" role="img" aria-label="Couldn't send">
      <Icon name="alert" />
    </span>
  );
}

