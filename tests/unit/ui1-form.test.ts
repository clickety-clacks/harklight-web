// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, RawNumber, stringify } from '../../src/relay/json';
import { compose, emptyDraft, summarize, terminalScene, toPoint, actionTextKey } from '../../src/ui1/form';
import { answerForm } from '../../src/state/message';

const corpus = parse(readFileSync(new URL('../fixtures/attention-client-ui1-conformance-v3.json', import.meta.url), 'utf8')) as {
  cases: { id: string; document: Record<string, unknown> }[];
};
const all = corpus.cases.find((c) => c.id === 'accept-all-primitives-inputs-scenes-constructors-and-optionals')!.document;

describe('exact JSON', () => {
  it('keeps numbers a JavaScript number cannot hold, and writes them back unchanged', () => {
    const v = parse('{"a":18446744073709551617,"b":9007199254740993,"c":1e1000,"d":1.5,"e":-0}') as Record<string, unknown>;
    expect(v.a).toBeInstanceOf(RawNumber);
    expect(v.d).toBe(1.5);
    expect(stringify(v)).toBe('{"a":18446744073709551617,"b":9007199254740993,"c":1e1000,"d":1.5,"e":-0}');
  });
});

describe('composing a custom form answer', () => {
  it('builds the answer the iPhone app builds', () => {
    const d = emptyDraft();
    d.selected.cover = 'cover-b';
    d.text.note = '  Exact note\n🗺  ';
    d.points.location = { x: 500, y: 500 };
    const c = compose(all, d);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(stringify(c.answer)).toBe(
      '{"cover":{"cover":"B","issue":18446744073709551617},"note":"  Exact note\\n🗺  ","location":{"x":500,"y":500},"details":[true,{"x":500,"y":500}]}',
    );
  });
  it('sends a text action’s words as the input’s value', () => {
    const d = emptyDraft();
    d.selected.cover = 'note-action';
    d.actionText[actionTextKey('cover', 'note-action')] = 'Neither';
    d.points.location = { x: 1, y: 2 };
    const c = compose(all, d);
    expect(c.ok && (c.answer as Record<string, unknown>).cover).toBe('Neither');
  });
  it('is incomplete until every choice and point is set, and something has content', () => {
    const d = emptyDraft();
    expect(compose(all, d)).toEqual({ ok: false, reason: 'incomplete' });
    d.selected.cover = 'cover-a';
    expect(compose(all, d)).toEqual({ ok: false, reason: 'incomplete' });
    d.points.location = { x: 0, y: 1000 };
    expect(compose(all, d).ok).toBe(true);
  });
  it('maps the pointer to the app’s 0..1000 grid', () => {
    const r = { left: 20, top: 40, width: 200, height: 100 };
    expect(toPoint(68, 101, r)).toEqual({ x: 240, y: 610 });
    expect(toPoint(-50, 500, r)).toEqual({ x: 0, y: 1000 });
  });
  it('summarizes the answer for the answered card', () => {
    const d = emptyDraft();
    d.selected.cover = 'cover-b';
    d.text.note = 'Hi';
    d.points.location = { x: 5, y: 6 };
    expect(summarize(all, d)).toBe('Choose a cover\nUse cover B\nNote\nHi\nMark the repair location\nHorizontal 5, vertical 6');
  });
  it('picks the terminal scene by state, else resolved', () => {
    expect(terminalScene(all, 'answered')).toEqual({ kind: 'text', text: 'Answered', style: 'caption' });
    expect((terminalScene(all, 'expired') as Record<string, unknown>).kind).toBe('grid');
  });
  it('draws a form only when the flag is on and the form is valid for the delivered files', () => {
    const files = ['cover-a.jpg', 'cover-b.jpg', 'floor plan.png'];
    expect(answerForm({ answer_ui: all } as never, { enabled: false, fileNames: files }).kind).toBe('unsupported');
    expect(answerForm({ answer_ui: all } as never, { enabled: true, fileNames: files }).kind).toBe('ui1');
    expect(answerForm({ answer_ui: all } as never, { enabled: true, fileNames: [] }).kind).toBe('unsupported');
  });
});
