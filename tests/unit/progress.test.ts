import { describe, expect, it } from 'vitest';
import { parse } from '../../src/state/json';
import { isProgress, progressFinished, seenKeepsOpen } from '../../src/state/message';
import type { JsonObject } from '../../src/state/types';

const progress = (over: JsonObject = {}): JsonObject => ({
  percent: 100,
  stage: 'Done',
  updated_at: '2026-11-24T12:00:00Z',
  segments: [{ stage: 'Build', width: 60 }, { stage: 'Done', width: 40 }],
  ...over,
});
const without = (k: string): JsonObject => {
  const p = progress();
  delete p[k];
  return p;
};
const fyi = (p: unknown): JsonObject => ({ message_type: 'fyi', progress: p as JsonObject });

describe('Progress messages', () => {
  it('are FYIs with a progress member, readable or not', () => {
    expect(isProgress(fyi(progress()))).toBe(true);
    expect(isProgress(fyi(null))).toBe(true);
    expect(isProgress({ message_type: 'fyi' })).toBe(false);
    expect(isProgress({ message_type: 'request', progress: progress() })).toBe(false);
  });

  it('are finished only when readable and at 100', () => {
    expect(progressFinished(fyi(progress()))).toBe(true);
    expect(progressFinished(fyi(progress({ stage: '', note: null, updated_at: '2026-11-24T12:00:00.5+01:00' })))).toBe(true);
    for (const p of [
      null,
      'x',
      {},
      progress({ percent: 99.9, segments: [{ stage: 'Build', width: 99.9 }] }),
      progress({ percent: '100' }),
      progress({ percent: 101 }),
      progress({ stage: 1 }),
      progress({ note: 1 }),
      progress({ updated_at: 'yesterday' }),
      without('updated_at'),
      without('segments'),
      progress({ segments: [{ stage: 'Build', width: 60 }] }),
      progress({ segments: [{ stage: 'Build', width: 'x' }] }),
      progress({ segments: [{ width: 100 }] }),
      progress({ segments: [{ stage: 'Build', width: 100, note: 2 }] }),
    ])
      expect(progressFinished(fyi(p)), JSON.stringify(p)).toBe(false);
  });

  it('are finished whatever way the sender wrote the numbers, read as the app reads them', () => {
    const wire = (percent: string, a: string, b: string) =>
      parse(
        `{"message_type":"fyi","progress":{"percent":${percent},"stage":"Done","updated_at":"2026-11-24T12:00:00Z","segments":[{"stage":"A","width":${a}},{"stage":"B","width":${b}}]}}`,
      ) as JsonObject;
    for (const [p, a, b] of [['100', '60', '40'], ['100.0', '60.0', '40.0'], ['1e2', '100', '0'], ['100', '33.3', '66.70'], ['100', '6e1', '4.0e1']])
      expect(progressFinished(wire(p, a, b)), `${p} ${a} ${b}`).toBe(true);
    for (const [p, a, b] of [['99.0', '59.0', '40'], ['100.0', '60.0', '30.0'], ['1e999', '60', '40'], ['100', '-1.0', '101.0']])
      expect(progressFinished(wire(p, a, b)), `${p} ${a} ${b}`).toBe(false);
  });

  it('take Seen without an answer while open, unfinished and offering Seen', () => {
    const seen = { answer_ui: { schema: 'attention-client.actions/1', actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: 'seen' }] } };
    const open = (payload: JsonObject, terminal: unknown = null) => seenKeepsOpen({ payload, terminal });
    const unfinished = progress({ percent: 60, segments: [{ stage: 'Build', width: 60 }] });
    expect(open({ ...fyi(unfinished), ...seen })).toBe(true);
    expect(open({ ...fyi('unreadable'), ...seen })).toBe(true);
    expect(open({ ...fyi(progress()), ...seen })).toBe(false);
    expect(open({ ...fyi(unfinished), ...seen }, { state: 'answered' })).toBe(false);
    expect(open(fyi(unfinished))).toBe(false);
    expect(open({ message_type: 'fyi', ...seen })).toBe(false);
    expect(open({ message_type: 'request', progress: unfinished, ...seen })).toBe(false);
  });
});
