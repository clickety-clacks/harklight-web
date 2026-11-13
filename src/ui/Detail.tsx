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
  | { kind: 'ui1'; answer: unknown; summary: string };

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
  fileHref: (uploadId: string) => string;
}

export function Detail(p: DetailProps) {
  const m = p.message;
  const type = messageType(m.payload);
  const form = answerForm(m.payload, { enabled: p.answerForms, fileNames: m.firstFiles.map((f) => f.name) });
  const sender = senderLabel(m);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [formError, setFormError] = useState<string | null>(null);

  const local = p.local;
  const sending = local?.state === 'sending';
  const seenDone = (m.terminal?.outcome?.kind === 'seen' || (local?.seen && local.state !== 'failed')) ?? false;
  const answered =
    !seenDone &&
    (m.terminal?.state === 'answered' ||
      m.terminal?.state === 'no_comment' ||
      (local && !local.seen && (local.state === 'accepted' || local.state === 'unconfirmed' || local.state === 'sending')));
  const open = m.terminal === null && !answered && !seenDone;
  const canAnswer = open && p.canAct && !sending;

  const choices = form.kind === 'choices' ? form.choices : [];
  const pickedChoice = choices.find((c) => c.id === picked) ?? null;
  // A custom form's checkmark stays on while the message is open; what is
  // missing is said when it is pressed, as on the phone.
  const ready =
    picked === 'no_comment' ||
    form.kind === 'ui1' ||
    (pickedChoice !== null && (pickedChoice.kind === 'value' || text.trim() !== ''));

  const commit = () => {
    if (!ready || !canAnswer) return;
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
      p.onAnswer({ kind: 'ui1', answer: c.answer, summary: summarize(form.doc, draft) });
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
          {open && !isSeenForm && form.kind !== 'unsupported' && (
            <button
              type="button"
              class="tool tool--square tool--commit"
              aria-label={form.kind === 'ui1' ? String((form.doc.submission as Record<string, unknown>).label) : 'Send answer'}
              disabled={!ready || !canAnswer}
              onClick={commit}
            >
              <Icon name="check" />
            </button>
          )}
          {open && form.kind === 'unsupported' && picked === 'no_comment' && (
            <button type="button" class="tool tool--square tool--commit" aria-label="Send answer" disabled={!canAnswer} onClick={commit}>
              <Icon name="check" />
            </button>
          )}
          {open && isSeenForm && (
            <button
              type="button"
              class="tool tool--seen"
              disabled={!canAnswer}
              onClick={() => form.kind === 'seen' && p.onSeen(form.value)}
            >
              <Icon name="check" />
              Seen
            </button>
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
              heading={m.terminal?.state === 'no_comment' || local?.noComment ? 'No comment' : 'Answered'}
              text={m.terminal?.state === 'no_comment' || local?.noComment ? null : answeredText(m, local?.label ?? null)}
            />
          )}
          {seenDone && <AnsweredCard heading="Seen" text={null} />}

          {open && isSeenForm && (
            <button
              type="button"
              class="tool seen-under"
              disabled={!canAnswer}
              onClick={() => form.kind === 'seen' && p.onSeen(form.value)}
            >
              <Icon name="eye" />
              Seen
            </button>
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
                    disabled={!canAnswer}
                    onPick={() => setPicked(c.id)}
                    onText={setText}
                    onSubmit={commit}
                  />
                ) : (
                  <ChoiceCard
                    key={c.id}
                    choice={c}
                    on={picked === c.id}
                    compact={writing}
                    disabled={!canAnswer}
                    onPick={() => setPicked(c.id)}
                  />
                ),
              )}
              <ChoiceCard
                choice={{ id: 'no_comment', label: 'No comment', kind: 'value', suggested: false }}
                on={picked === 'no_comment'}
                compact={writing}
                disabled={!canAnswer}
                onPick={() => setPicked('no_comment')}
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
                  onDraft: canAnswer
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
                  disabled={!canAnswer}
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
          {form.kind === 'ui1' && m.terminal && !answered && !seenDone && !m.terminal.retracted && (
            <div class="u-form">
              <Scene
                node={terminalScene(form.doc, m.terminal.state)}
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
                  disabled={!canAnswer}
                  onPick={() => setPicked('no_comment')}
                />
              </div>
            </>
          )}
          <AnswerStatus local={local} />
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

function ChoiceCard(p: {
  choice: Choice;
  on: boolean;
  compact: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const c = p.choice;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={p.on}
      class={p.on ? 'choice choice--on' : 'choice'}
      disabled={p.disabled}
      onClick={p.onPick}
    >
      <span class="mark" aria-hidden="true" />
      <span class="choice-text">
        <span class="ti">
          {c.label}
          {c.suggested && <span class="sug">Suggested</span>}
        </span>
        {!p.compact && c.description && <span class="de">{c.description}</span>}
      </span>
    </button>
  );
}

function ReplyCard(p: {
  choice: Choice;
  on: boolean;
  text: string;
  disabled: boolean;
  onPick: () => void;
  onText: (t: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div class={p.on ? 'replycard replycard--on' : 'replycard'}>
      <button
        type="button"
        role="radio"
        aria-checked={p.on}
        class="rc-head"
        disabled={p.disabled}
        onClick={p.onPick}
      >
        <span class="mark" aria-hidden="true" />
        <span class="ti">{p.choice.label}</span>
      </button>
      {p.on && (
        <textarea
          class="rc-pane"
          aria-label={p.choice.label}
          value={p.text}
          disabled={p.disabled}
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

function AnsweredCard(p: { heading: string; text: string | null }) {
  return (
    <div class="answered" data-testid="answered">
      <div class="an-head">
        <Icon name="check" />
        {p.heading}
      </div>
      {p.text && <div class="an-text">{p.text}</div>}
    </div>
  );
}

const STATUS: Partial<Record<LocalAnswer['state'], string>> = {
  failed: 'Your answer was not delivered. Try again.',
  stale: 'This message changed. Review the latest version before answering.',
  closed: 'This message is no longer open for an answer.',
  retracted: 'The sender retracted this message before your answer was accepted.',
  unconfirmed: 'Your answer was sent but not confirmed yet.',
};

function AnswerStatus(p: { local: LocalAnswer | undefined }) {
  const text = p.local && STATUS[p.local.state];
  if (!text) return null;
  return (
    <p class="msg-note msg-note--bad" role="status">
      {text}
    </p>
  );
}
