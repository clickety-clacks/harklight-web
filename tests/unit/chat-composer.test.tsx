import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { Chat, type ChatDraft, type ChatProps } from '../../src/ui/Chat';
import type { HeldMessage } from '../../src/state/types';

const message: HeldMessage = {
  sender_id: 'agent:a',
  message_id: 'm1',
  payload: {},
  revision: 1,
  acceptedSeq: 1,
  terminal: null,
  files: [],
  firstFiles: [],
  chat: true,
};

function mount(over: Partial<ChatProps> = {}) {
  const el = document.createElement('div');
  document.body.append(el);
  let draft: ChatDraft = { text: '', files: [] };
  const props: ChatProps = {
    message,
    sender: 'Agent',
    thread: undefined,
    sends: [],
    open: true,
    available: true,
    attachments: true,
    uploadCap: null,
    canSend: true,
    paused: false,
    onClose: () => {},
    column: false,
    draft,
    onDraft: (d) => (draft = d),
    onSend: () => {},
    onRetry: () => {},
    onReplyVisible: () => {},
    fileHref: (id) => id,
    ...over,
  };
  render(<Chat {...props} />, el);
  return { el, draft: () => draft };
}

describe('chat composer', () => {
  it('keeps a second file with the same name under a new name', () => {
    const { el, draft } = mount();
    const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
    const files = ['photo.png', 'photo.png', 'photo.png', 'notes'].map((n) => new File(['x'], n));
    Object.defineProperty(input, 'files', { value: files });
    input.dispatchEvent(new Event('change'));
    expect(draft().files.map((f) => f.name)).toEqual(['photo.png', 'photo (2).png', 'photo (3).png', 'notes']);
  });

  it('leaves the text box and attach button usable while the connection is down, and only send waits', () => {
    const { el } = mount({ canSend: false });
    expect(el.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('button[aria-label="Attach a file"]')!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
  });

  it('offers no Retry on a failed turn while the account is paused', () => {
    const failed = { op_id: 'o1', key: `${message.sender_id}\u0000${message.message_id}`, revision: 1, text: 'hi', files: [], state: 'failed' as const, reason: 'connection' };
    const retry = (paused: boolean) => mount({ sends: [failed], paused }).el.textContent?.includes('Retry');
    expect(retry(false)).toBe(true);
    expect(retry(true)).toBe(false);
  });
});
