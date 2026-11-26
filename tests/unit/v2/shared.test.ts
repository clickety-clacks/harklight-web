import { expect, it } from 'vitest';
import { readMe, readTerminal } from '../../../src/v2/wire';

it('discovers only an explicitly enabled shared messaging feature', () => {
  expect(readMe({ limits: {}, features: { shared_messages: true } })).toMatchObject({ sharedMessages: true });
  expect(readMe({ limits: {}, features: { shared_messages: false } })).toMatchObject({ sharedMessages: false });
  expect(readMe({ limits: {} })).toMatchObject({ sharedMessages: false });
});

it('keeps the answer speaker and stable answer identity', () => {
  const speaker = { kind: 'person', id: 'example-speaker', display_name: 'Dana' };
  const terminal = { state: 'answered', speaker, answer_id: 'example-answer', by_this_person: false };
  expect(readTerminal(terminal)).toMatchObject(terminal);
});
