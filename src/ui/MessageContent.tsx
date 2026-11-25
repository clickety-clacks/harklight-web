import { useEffect, useState } from 'preact/hooks';
import { body, friendlyTime, initials, messageType, senderLabel, title, TYPE_ICON } from '../state/message';
import type { HeldMessage } from '../state/types';
import { FileRow } from './FileRow';
import { Icon } from './Icon';

function friendlyLong(ms: number): string {
  const short = friendlyTime(ms);
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today, ${short}`;
  return short;
}

export function MessageHeading({ message, timestamp, priority, showMessageId }: {
  message: HeldMessage;
  timestamp: number | null;
  priority?: string;
  showMessageId?: boolean;
}) {
  const sender = senderLabel(message);
  const heading = (
    <h2 class="msg-title" tabIndex={-1}>
      <Icon name={TYPE_ICON[messageType(message.payload)]} />
      <span>{title(message)}</span>
    </h2>
  );
  return (
    <>
      {showMessageId && heading}
      <div class="msg-head">
        <span class="initials" aria-hidden="true">{initials(sender)}</span>
        {priority ? <>
          <span class="msg-agent">{sender}</span>
          <span class="fyi-priority">{priority}</span>
          {timestamp !== null && <time>{friendlyTime(timestamp)}</time>}
        </> : <span>{sender}{timestamp !== null && ` · ${friendlyLong(timestamp)}`}</span>}
        {showMessageId && <CopyMessageId id={message.message_id} />}
      </div>
      {!showMessageId && heading}
    </>
  );
}

function CopyMessageId({ id }: { id: string }) {
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 1600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setFeedback('Copied');
    } catch {
      setFeedback('Could not copy');
    }
  }

  return (
    <>
      <button type="button" class="message-id" aria-label="Copy message ID" aria-description={id}
        onClick={() => void copy()}>
        {feedback || id}
      </button>
      <span class="visually-hidden" role="status">{feedback}</span>
    </>
  );
}

export function MessageContent(p: { message: HeldMessage; attachments: boolean; fileHref: (id: string) => string }) {
  const text = body(p.message);
  return (
    <>
      {text && <p class="msg-body">{text}</p>}
      {p.message.files.length > 0 && (
        <div class="files">
          {p.message.files.map((file, i) => (
            <FileRow key={`${i}\u0000${file.name}`} file={file} download={p.attachments} fileHref={p.fileHref} />
          ))}
        </div>
      )}
    </>
  );
}
