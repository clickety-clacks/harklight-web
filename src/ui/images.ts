import type { Config } from '../config';
import type { WireFile } from '../state/types';

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  avif: 'image/avif',
};

function typeOf(name: string): string {
  return TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png';
}

/** Image types supported by the UI/1 form renderer before the v2 cut-over. */
const FORM_PICTURE_TYPES = new Set(Object.values(TYPES));

/**
 * The type a client API v2 file is drawn as: its stored type (FileRef.content_type),
 * or for a file with none (from before the cut-over) the type its name says.
 * Null when it is not a picture the web draws.
 */
export function formPictureType(f: Pick<WireFile, 'name' | 'content_type'>): string | null {
  const stored = f.content_type?.split(';')[0].trim().toLowerCase();
  const t = stored && stored !== 'application/octet-stream' ? stored : TYPES[f.name.split('.').pop()?.toLowerCase() ?? ''];
  return t && FORM_PICTURE_TYPES.has(t) ? t : null;
}

const cache = new Map<string, Promise<string | null>>();

/**
 * A URL the page can draw for a picture a custom answer form names. Inline
 * files come from the message itself; uploaded ones are fetched (they are
 * served as downloads, so they are read as bytes and shown from memory).
 */
export function imageUrlFor(f: WireFile, config: Config, fileHref: (id: string) => string): Promise<string | null> {
  const key = f.file_id ?? f.upload_id ?? `${f.name}\u0000${f.sha256 ?? ''}`;
  let p = cache.get(key);
  if (!p) {
    p = load(f, config, fileHref);
    cache.set(key, p);
  }
  return p;
}

async function load(f: WireFile, config: Config, fileHref: (id: string) => string): Promise<string | null> {
  try {
    if (f.data_base64 !== undefined) {
      const bin = atob(f.data_base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: typeOf(f.name) }));
    }
    // On client API v2 a picture a custom form names arrives as a file (the
    // relay sent small ones inline). It is part of the message, not a chat
    // file, so it is shown whether or not chat files are on. Files are served
    // as downloads, so the bytes become a typed Blob, and only an allowed
    // picture type is drawn.
    if (f.file_id !== undefined) {
      const type = formPictureType(f);
      if (!type) return null;
      const res = await fetch(fileHref(f.file_id), { credentials: 'same-origin', redirect: 'manual' });
      if (!res.ok) return null;
      return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    }
    const id = f.upload_id;
    if (id && (f.file_id !== undefined || config.flags.attachments)) {
      const res = await fetch(fileHref(id), { credentials: 'same-origin', redirect: 'manual' });
      if (!res.ok) return null;
      return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: typeOf(f.name) }));
    }
  } catch {
    // Shown as a picture that could not be shown.
  }
  return null;
}
