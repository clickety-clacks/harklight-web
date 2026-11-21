// How one held message reads on screen: its type, its sender label, its
// answer controls and its status. Pure functions over the payload the Server
// delivered, so they are easy to test.

import { sameJson } from '../relay/json';
import { UI1_SCHEMA, validateUi1, type Ui1Limits } from '../ui1/validate';
import type { HeldMessage, Json, JsonObject } from './types';

export type MessageType = 'request' | 'info' | 'done' | 'warn' | 'error';

export interface Choice {
  id: string;
  label: string;
  /** A value choice sends this value. A text choice has none. */
  value?: Json;
  kind: 'value' | 'text';
  description?: string;
  suggested: boolean;
}

export type AnswerForm =
  /** Read-only messages: Seen sends the declared Seen value. */
  | { kind: 'seen'; value: Json }
  /**
   * Choices and/or a text reply, sent with the checkmark. `notShown` is set
   * when the message carries a custom answer screen that is not drawn (the
   * Server replaced it, or this client cannot show it): the person gets the
   * plain Reply and is told so.
   */
  | { kind: 'choices'; choices: Choice[]; notShown?: boolean }
  /** A custom answer form (attention-client.ui/1) that passed the grammar. */
  | { kind: 'ui1'; doc: JsonObject };

const ACTIONS_SCHEMA = 'attention-client.actions/1';

function str(v: Json | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function isObject(v: Json | undefined): v is JsonObject {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The Seen descriptor the Server accepts for an information message. */
export function seenValue(payload: JsonObject): Json | null {
  const ui = payload.answer_ui;
  if (!isObject(ui) || ui.schema !== ACTIONS_SCHEMA || !Array.isArray(ui.actions)) return null;
  if (ui.actions.length !== 1) return null;
  const a = ui.actions[0];
  if (!isObject(a) || a.id !== 'seen' || a.kind !== 'value' || !('value' in a)) return null;
  return a.value as Json;
}

const PLAIN_REPLY: Choice = { id: 'reply', label: 'Reply', kind: 'text', suggested: false };

/** The plain Reply a message with no screen gets, for a screen that cannot be shown. */
function plainReply(notShown: boolean): AnswerForm {
  return notShown ? { kind: 'choices', choices: [PLAIN_REPLY], notShown } : { kind: 'choices', choices: [PLAIN_REPLY] };
}

/**
 * How the message is answered. Custom forms are drawn only when `forms` is
 * on and the form passes the grammar against revision 1's file names. A
 * screen that cannot be drawn (unknown version, over a limit, malformed, or
 * forms off) falls back to the plain Reply, with No comment, and says so.
 */
export function answerForm(payload: JsonObject, forms?: { enabled: boolean; fileNames: string[]; limits?: Ui1Limits }): AnswerForm {
  const seen = seenValue(payload);
  if (seen !== null) return { kind: 'seen', value: seen };
  if (!('answer_ui' in payload)) {
    // A message without answer controls takes a plain text reply. One whose
    // screen the Server dropped says so.
    return plainReply('answer_ui_unavailable' in payload);
  }
  const ui = payload.answer_ui;
  const degraded = 'answer_ui_unavailable' in payload;
  if (isObject(ui) && ui.schema === UI1_SCHEMA && forms?.enabled) {
    try {
      validateUi1(ui, forms.fileNames, forms.limits);
      return { kind: 'ui1', doc: ui };
    } catch {
      return plainReply(true);
    }
  }
  if (!isObject(ui) || ui.schema !== ACTIONS_SCHEMA || !Array.isArray(ui.actions)) {
    return plainReply(true);
  }
  const suggestedValue = isObject(payload.default) ? payload.default.value : undefined;
  const choices: Choice[] = [];
  const seenIds = new Set<string>();
  for (const a of ui.actions) {
    if (!isObject(a)) return plainReply(true);
    const id = str(a.id);
    const label = str(a.label);
    if (!id || !label || seenIds.has(id)) return plainReply(true);
    seenIds.add(id);
    if (a.kind === 'value' && 'value' in a) {
      choices.push({
        id,
        label,
        kind: 'value',
        value: a.value as Json,
        description: str(a.description) ?? str(a.detail),
        suggested: suggestedValue !== undefined && sameJson(a.value as Json, suggestedValue as Json),
      });
    } else if (a.kind === 'text') {
      choices.push({ id, label, kind: 'text', description: str(a.description), suggested: false });
    } else {
      return plainReply(true);
    }
  }
  if (choices.length === 0) return plainReply(true);
  return degraded ? { kind: 'choices', choices, notShown: true } : { kind: 'choices', choices };
}

export { sameJson } from '../relay/json';

/**
 * The five message types of the design. The wire has `message_type` (request
 * or fyi) and `message_kind` (blocker or success). A request asks for an
 * answer; a blocker request is an error. A read-only message is information,
 * a success is done and a blocker is a warning.
 */
export function messageType(payload: JsonObject): MessageType {
  const kind = payload.message_kind;
  const readOnly = payload.message_type === 'fyi' || (payload.message_type !== 'request' && seenValue(payload) !== null);
  if (readOnly) {
    if (kind === 'success') return 'done';
    if (kind === 'blocker') return 'warn';
    return 'info';
  }
  if (kind === 'blocker') return 'error';
  return 'request';
}

export const TYPE_ICON: Record<MessageType, string> = {
  request: 'request',
  info: 'info',
  done: 'done',
  warn: 'warn',
  error: 'error',
};

/** The sender's display name, else the short form of its id. */
export function senderLabel(m: { sender_id: string; payload: JsonObject }): string {
  const name = str(m.payload.display_name);
  if (name) return name;
  const id = m.sender_id;
  const afterColon = id.slice(id.lastIndexOf(':') + 1);
  const afterSlash = afterColon.slice(afterColon.lastIndexOf('/') + 1);
  return afterSlash || id;
}

export function initials(label: string): string {
  const words = label.split(/[^\p{L}]+/u).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function title(m: HeldMessage): string {
  return str(m.payload.title) ?? 'Message';
}

export function body(m: HeldMessage): string {
  return typeof m.payload.body === 'string' ? m.payload.body : '';
}

export function createdAt(m: HeldMessage): number | null {
  return typeof m.payload.created_at === 'number' ? m.payload.created_at : null;
}

/** Friendly time: today shows the time, then Yesterday, a weekday within a
 * week, else a short date. */
export function friendlyTime(ms: number | null, now: Date = new Date()): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(d)) / 86_400_000);
  if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays >= 2 && diffDays <= 6) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { dateStyle: 'short' });
}

/** Whether the person still owes this message something. */
export function isOpen(m: HeldMessage): boolean {
  return m.terminal === null;
}

/**
 * Messages the person answered or gave No comment go to Replied. A message
 * marked Seen stays in the Inbox list with its check, as the design draws it.
 */
export function belongsToReplied(m: HeldMessage, localAnswered: boolean): boolean {
  if (localAnswered) return true;
  const t = m.terminal;
  if (!t || t.outcome?.kind === 'seen') return false;
  return t.state === 'answered' || t.state === 'no_comment';
}

export type Priority = 'urgent' | 'high' | null;

/** Priority comes from the priority view's score, as on the phone. */
export function priorityOf(score: number | null): Priority {
  if (score === null || !Number.isFinite(score)) return null;
  if (score >= 0.9) return 'urgent';
  if (score >= 0.7) return 'high';
  return null;
}

/** The answered card's line: the Server's outcome text, else the label of the
 * choice this tab sent. */
export function answeredText(m: HeldMessage, localLabel: string | null): string | null {
  const o = m.terminal?.outcome;
  if (o) {
    if (o.kind === 'reply' && o.text !== undefined) {
      // A string choice value reads like typed text on the wire; show its label.
      const form = answerForm(m.payload);
      if (form.kind === 'choices') {
        const c = form.choices.find((c) => c.kind === 'value' && c.value === o.text);
        if (c) return c.label;
      }
      return o.text || null;
    }
    if (o.kind === 'default') {
      if (o.text) return o.text;
      const form = answerForm(m.payload);
      if (form.kind === 'choices' && o.value !== undefined) {
        const c = form.choices.find((c) => c.kind === 'value' && sameJson(c.value as Json, o.value as Json));
        if (c) return c.label;
      }
      return null;
    }
    if (o.kind === 'seen' || o.kind === 'no_comment') return null;
  }
  return localLabel;
}
