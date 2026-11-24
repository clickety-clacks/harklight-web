import { describe, expect, it } from 'vitest';
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

  it('take Seen without an answer until finished; other messages are unaffected', () => {
    expect(seenKeepsOpen(fyi(progress({ percent: 60, segments: [{ stage: 'Build', width: 60 }] })))).toBe(true);
    expect(seenKeepsOpen(fyi('unreadable'))).toBe(true);
    expect(seenKeepsOpen(fyi(progress()))).toBe(false);
    expect(seenKeepsOpen({ message_type: 'fyi' })).toBe(false);
    expect(seenKeepsOpen({ message_type: 'request' })).toBe(false);
  });
});
