// A custom answer form's draft and the answer it composes, following the
// iPhone app: every choice input needs a selection, every point input needs a
// point, at least one field must carry content, and the answer must fit in
// 64 KiB.

import { stringify, utf8Length } from '../relay/json';

type Obj = Record<string, unknown>;

export interface Action {
  id: string;
  label: string;
  kind: 'value' | 'text';
  value?: unknown;
  illustration?: string;
}

export type Input =
  | { kind: 'response'; id: string; label: string; actions: Action[] }
  | { kind: 'text'; id: string; label: string }
  | { kind: 'point'; id: string; label: string; illustration: string };

export interface Point {
  x: number;
  y: number;
}

/** What the person has entered so far. */
export interface Draft {
  /** response input id -> selected action id */
  selected: Record<string, string | undefined>;
  /** response input id + action id -> typed text for a text action */
  actionText: Record<string, string>;
  /** text input id -> typed text */
  text: Record<string, string>;
  /** point input id -> point */
  points: Record<string, Point | undefined>;
}

export function emptyDraft(): Draft {
  return { selected: {}, actionText: {}, text: {}, points: {} };
}

export const actionTextKey = (inputId: string, actionId: string) => `${inputId}\u0000${actionId}`;

export function inputsOf(doc: Obj): Input[] {
  return doc.inputs as Input[];
}

/** One input's contribution, or undefined when it is not answered yet. */
function contribution(input: Input, draft: Draft): unknown {
  switch (input.kind) {
    case 'response': {
      const id = draft.selected[input.id];
      const action = input.actions.find((a) => a.id === id);
      if (!action) return undefined;
      return action.kind === 'value' ? action.value : (draft.actionText[actionTextKey(input.id, action.id)] ?? '');
    }
    case 'text':
      return draft.text[input.id] ?? '';
    case 'point': {
      const p = draft.points[input.id];
      return p ? { x: p.x, y: p.y } : undefined;
    }
  }
}

function evaluate(c: Obj, values: Map<string, unknown>): unknown {
  switch (c.kind) {
    case 'literal':
      return c.value;
    case 'input':
      return values.get(c.id as string);
    case 'array':
      return (c.items as Obj[]).map((i) => evaluate(i, values));
    case 'object': {
      const out: Record<string, unknown> = Object.create(null);
      for (const m of c.members as Obj[]) out[m.name as string] = evaluate(m.value as Obj, values);
      return out;
    }
  }
  return null;
}

/** Content is any character that is not Unicode White_Space, as the app tests. */
const hasContent = (s: string) => /\P{White_Space}/u.test(s);

export type Composed = { ok: true; answer: unknown } | { ok: false; reason: 'incomplete' | 'too_large' };

export function compose(doc: Obj, draft: Draft): Composed {
  const inputs = inputsOf(doc);
  const values = new Map<string, unknown>();
  let content = false;
  for (const input of inputs) {
    const v = contribution(input, draft);
    if (v === undefined) return { ok: false, reason: 'incomplete' };
    values.set(input.id, v);
    if (input.kind === 'point') content = true;
    if (input.kind === 'text' && hasContent(v as string)) content = true;
    if (input.kind === 'response') {
      const action = input.actions.find((a) => a.id === draft.selected[input.id])!;
      if (action.kind === 'value' || hasContent(v as string)) content = true;
    }
  }
  if (!content) return { ok: false, reason: 'incomplete' };
  const answer = evaluate((doc.submission as Obj).result as Obj, values);
  if (utf8Length(stringify(answer)) > 65_536) return { ok: false, reason: 'too_large' };
  return { ok: true, answer };
}

/** The answered card's text: each input's answer, labelled when there are
 * several, as the app summarizes a sent answer. */
export function summarize(doc: Obj, draft: Draft): string {
  const inputs = inputsOf(doc);
  const parts: string[] = [];
  for (const input of inputs) {
    let line: string | null = null;
    if (input.kind === 'response') {
      const action = input.actions.find((a) => a.id === draft.selected[input.id]);
      if (action) line = action.kind === 'value' ? action.label : (draft.actionText[actionTextKey(input.id, action.id)] ?? '');
    } else if (input.kind === 'text') {
      const t = draft.text[input.id] ?? '';
      if (t !== '') line = t;
    } else {
      const p = draft.points[input.id];
      if (p) line = `Horizontal ${p.x}, vertical ${p.y}`;
    }
    if (line === null) continue;
    parts.push(inputs.length > 1 && input.label !== 'Response' ? `${input.label}\n${line}` : line);
  }
  return parts.join('\n');
}

/** Map a pointer position inside the drawing to the app's 0..1000 grid. */
export function toPoint(px: number, py: number, rect: { left: number; top: number; width: number; height: number }): Point {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const u = clamp((px - rect.left) / rect.width);
  const v = clamp((py - rect.top) / rect.height);
  return { x: Math.floor(1000 * u + 0.5), y: Math.floor(1000 * v + 0.5) };
}

/** The terminal scene for a closed message: by state, else `resolved`. */
export function terminalScene(doc: Obj, state: string): Obj {
  const byState = doc.resolvedByState as Obj | undefined;
  return ((byState && (byState[state] as Obj)) ?? doc.resolved) as Obj;
}

