// The shared UI/1 conformance corpus: the same cases Harklight Server and the
// iPhone app agree on. The browser must give the same verdicts and name the
// same fault location.
// The corpus was written against the earlier fixed bounds, so it runs at those
// (CORPUS_LIMITS); the web client's own bounds are the generous WEB_LIMITS.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/relay/json';
import { CORPUS_LIMITS, parseUi1Limits, Ui1Fault, validateUi1, WEB_LIMITS } from '../../src/ui1/validate';

const raw = readFileSync(new URL('../fixtures/attention-client-ui1-conformance-v3.json', import.meta.url), 'utf8');
const corpus = parse(raw) as { cases: Record<string, unknown>[] };

describe('UI/1 conformance corpus', () => {
  it('has the expected cases', () => {
    expect(corpus.cases.length).toBe(198);
  });
  for (const c of corpus.cases) {
    it(String(c.id), () => {
      let fault: Ui1Fault | null = null;
      try {
        validateUi1(c.document, c.delivered_file_names as string[], CORPUS_LIMITS);
      } catch (e) {
        if (!(e instanceof Ui1Fault)) throw e;
        fault = e;
      }
      if (c.verdict === 'accept') expect(fault?.message ?? null).toBe(null);
      else {
        expect(fault, 'expected a fault').not.toBe(null);
        expect(fault!.message).toContain((c.fault as { location: string }).location);
      }
    });
  }
});

describe('web limits', () => {
  const accepted = corpus.cases.filter((c) => c.verdict === 'accept');
  it('accept everything the earlier bounds accepted', () => {
    for (const c of accepted) expect(() => validateUi1(c.document, c.delivered_file_names as string[], WEB_LIMITS), String(c.id)).not.toThrow();
  });
  it('are far above the earlier bounds, and a form past them faults on the bound', () => {
    expect(WEB_LIMITS.inputs).toBeGreaterThan(CORPUS_LIMITS.inputs);
    const c = accepted[0];
    const doc = { ...(c.document as Record<string, unknown>), requires: Array.from({ length: WEB_LIMITS.requires + 1 }, (_, i) => `cap${i}`) };
    expect(() => validateUi1(doc, c.delivered_file_names as string[])).toThrow(/at most 32 capabilities/);
  });
});

describe('published limits', () => {
  const published = {
    document_bytes: 1_048_576, requires: 32, illustrations: 256, primitives_per_illustration: 4_096, primitives_total: 16_384,
    inputs: 128, actions: 512, scene_nodes: 4_096, scene_depth: 64, result_nodes: 4_096, result_depth: 64,
    result_point_path: 64, array_items: 4_096, object_members: 4_096, identifier_bytes: 512,
  };
  it('are read from the Server reply', () => {
    expect(parseUi1Limits(published)).toEqual(WEB_LIMITS);
    expect(parseUi1Limits({ ...published, inputs: 7 })?.inputs).toBe(7);
  });
  it('are ignored when absent or incomplete, so the web keeps its own', () => {
    expect(parseUi1Limits(undefined)).toBeNull();
    expect(parseUi1Limits({ ...published, inputs: 'many' })).toBeNull();
    const { actions: _a, ...missing } = published;
    expect(parseUi1Limits(missing)).toBeNull();
  });
});
