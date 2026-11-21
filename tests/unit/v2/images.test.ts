import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageUrlFor, previewType } from '../../../src/ui/images';
import { DEFAULT_CONFIG } from '../../../src/config';

describe('client API v2 pictures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws only PNG, JPEG, GIF and WebP, by the stored type, else by the name for files with none', () => {
    expect(previewType({ name: 'a.bin', content_type: 'image/png' })).toBe('image/png');
    expect(previewType({ name: 'a.png', content_type: 'image/jpeg; charset=x' })).toBe('image/jpeg');
    expect(previewType({ name: 'a.svg', content_type: 'image/svg+xml' })).toBeNull();
    expect(previewType({ name: 'a.png', content_type: 'text/html' })).toBeNull();
    // From before the cut-over: served as octet-stream, typed by name.
    expect(previewType({ name: 'cover.jpg', content_type: 'application/octet-stream' })).toBe('image/jpeg');
    expect(previewType({ name: 'cover.webp' })).toBe('image/webp');
    expect(previewType({ name: 'photo.heic' })).toBeNull();
    expect(previewType({ name: 'notes.txt' })).toBeNull();
  });

  it('fetches the bytes and builds a typed Blob; a type not on the list is never fetched', async () => {
    const fetched: string[] = [];
    const blobs: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => (blobs.push(b.type), 'blob:x') }));
    const href = (id: string) => `/v2/files/${id}`;
    expect(await imageUrlFor({ name: 'a.png', file_id: 'f-png', content_type: 'image/png' }, DEFAULT_CONFIG, href)).toBe('blob:x');
    expect(await imageUrlFor({ name: 'b.svg', file_id: 'f-svg', content_type: 'image/svg+xml' }, DEFAULT_CONFIG, href)).toBeNull();
    expect(fetched).toEqual(['/v2/files/f-png']);
    expect(blobs).toEqual(['image/png']);
  });
});
