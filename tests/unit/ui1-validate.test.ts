// The shared UI/1 conformance corpus: the same cases Harklight Server and the
// iPhone app agree on. The browser must give the same verdicts and name the
// same fault location.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/relay/json';
import { CORPUS_UI1_LIMITS, PUBLISHED_UI1_LIMITS, Ui1Fault, validateUi1 } from '../../src/ui1/validate';

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
        // The corpus checks the grammar at the limits it was written for.
        validateUi1(c.document, c.delivered_file_names as string[], CORPUS_UI1_LIMITS);
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

describe('UI/1 limits', () => {
  it('a screen over the corpus limits is drawn at the published limits', () => {
    const doc = corpus.cases.find((c) => c.id === 'reject-illustration-count');
    expect(doc, 'the corpus has an over-count case').toBeTruthy();
    expect(() => validateUi1(doc!.document, doc!.delivered_file_names as string[], CORPUS_UI1_LIMITS)).toThrow(Ui1Fault);
    expect(() => validateUi1(doc!.document, doc!.delivered_file_names as string[])).not.toThrow();
  });
  it('defaults to the published limits', () => {
    expect(PUBLISHED_UI1_LIMITS.document_bytes).toBe(1_048_576);
  });
});
