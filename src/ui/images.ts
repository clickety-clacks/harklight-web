import type { Config } from '../config';
import { fileUrl } from '../relay/files';
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

const cache = new Map<string, Promise<string | null>>();

/**
 * A URL the page can draw for a picture a custom answer form names. Inline
 * files come from the message itself; uploaded ones are fetched (they are
 * served as downloads, so they are read as bytes and shown from memory).
 */
export function imageUrlFor(f: WireFile, config: Config): Promise<string | null> {
  const key = f.upload_id ?? `${f.name}\u0000${f.sha256 ?? ''}`;
  let p = cache.get(key);
  if (!p) {
    p = load(f, config);
    cache.set(key, p);
  }
  return p;
}

async function load(f: WireFile, config: Config): Promise<string | null> {
  try {
    if (f.data_base64 !== undefined) {
      const bin = atob(f.data_base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: typeOf(f.name) }));
    }
    if (f.upload_id && config.flags.attachments) {
      const res = await fetch(fileUrl(config.filesPath, f.upload_id), { credentials: 'same-origin', redirect: 'manual' });
      if (!res.ok) return null;
      return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: typeOf(f.name) }));
    }
  } catch {
    // Shown as a picture that could not be shown.
  }
  return null;
}
