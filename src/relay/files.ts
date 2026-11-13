// The browser file routes (contract D-7a): limits, upload, discard and fetch.
// They behave as the device routes do; the person comes from the sign-in
// cookie and the tab's recipient id names the uploader.

import type { ChatSend } from '../state/types';

export interface FileRoutes {
  /** Base path, for example `/browser/v1`. */
  base: string;
  fetch: typeof fetch;
}

export interface FileLimits {
  inline: number;
  cap: number | null;
}

export interface Uploaded {
  upload_id: string;
  name: string;
  size: number;
  sha256: string;
}

/** A redirect means the sign-in ended (D-7b, A-3). */
function sessionEnded(res: Response): boolean {
  return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
}

async function command(routes: FileRoutes, recipient: string, body: Record<string, unknown>) {
  const res = await routes.fetch(`${routes.base}?recipient=${encodeURIComponent(recipient)}`, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, ...body }),
  });
  if (sessionEnded(res)) throw new Error('session_ended');
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || json.type !== 'ok') throw new Error(String(json?.reason ?? `http_${res.status}`));
  return json;
}

export async function fetchFileLimits(routes: FileRoutes, recipient: string): Promise<FileLimits> {
  const r = await command(routes, recipient, { type: 'file_limits' });
  const inline = typeof r.inline_decoded_bytes_per_entry === 'number' ? r.inline_decoded_bytes_per_entry : 0;
  const cap = typeof r.upload_cap_bytes_per_file === 'number' ? r.upload_cap_bytes_per_file : null;
  return { inline, cap };
}

/** base64url without padding, of the name's UTF-8 bytes. */
export function encodeName(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function uploadFile(
  routes: FileRoutes,
  recipient: string,
  f: { file: Blob; name: string; opId: string; senderId: string; messageId: string; revision: number },
): Promise<Uploaded> {
  const res = await routes.fetch(`${routes.base}/upload?recipient=${encodeURIComponent(recipient)}`, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'manual',
    headers: {
      'content-type': 'application/octet-stream',
      'x-harklight-file-name': encodeName(f.name),
      'x-harklight-op-id': f.opId,
      'x-harklight-sender-id': f.senderId,
      'x-harklight-message-id': f.messageId,
      'x-harklight-request-revision': String(f.revision),
    },
    body: f.file,
  });
  if (sessionEnded(res)) throw new Error('session_ended');
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || json.type !== 'ok') {
    const reason = String(json?.reason ?? `http_${res.status}`);
    if (reason === 'upload_cap_exceeded') throw new Error(`upload_cap_exceeded:${String(json?.upload_cap_bytes_per_file ?? '')}`);
    throw new Error(reason);
  }
  return {
    upload_id: String(json.upload_id),
    name: String(json.name),
    size: Number(json.size),
    sha256: String(json.sha256),
  };
}

/** Abandon this message revision's unreferenced uploads from this tab. */
export async function discardUploads(routes: FileRoutes, recipient: string, send: ChatSend): Promise<void> {
  const [sender_id, message_id] = send.key.split('\u0000');
  await command(routes, recipient, {
    type: 'discard_uploads',
    op_id: crypto.randomUUID(),
    sender_id,
    message_id,
    revision: send.revision,
  });
}

export function fileUrl(base: string, uploadId: string): string {
  return `${base}/files/${encodeURIComponent(uploadId)}`;
}
