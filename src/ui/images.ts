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
 * A URL the page can draw for a picture a custom answer form names. Files are
 * served as downloads, so they are read as bytes and shown from memory.
 */
export function imageUrlFor(f: WireFile, fileHref: (id: string) => string): Promise<string | null> {
  const key = f.file_id ?? `${f.name}\u0000${f.sha256 ?? ''}`;
  let p = cache.get(key);
  if (!p) {
    p = load(f, fileHref);
    cache.set(key, p);
  }
  return p;
}

async function load(f: WireFile, fileHref: (id: string) => string): Promise<string | null> {
  try {
    // Form pictures display independently of chat files.
    if (f.file_id) {
      const type = formPictureType(f);
      if (!type) return null;
      const res = await fetch(fileHref(f.file_id), { credentials: 'same-origin', redirect: 'manual' });
      if (!res.ok) return null;
      return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    }
  } catch {
    // Shown as a picture that could not be shown.
  }
  return null;
}
