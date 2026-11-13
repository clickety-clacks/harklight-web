// The shared UI/1 conformance corpus: the same cases Harklight Server and the
// iPhone app agree on. The browser must give the same verdicts and name the
// same fault location.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/relay/json';
import { Ui1Fault, validateUi1 } from '../../src/ui1/validate';

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
        validateUi1(c.document, c.delivered_file_names as string[]);
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
