import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageUrlFor, formPictureType } from '../../../src/ui/images';

describe('client API v2 pictures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the stored type for form pictures, with name fallback for migrated files', () => {
    expect(formPictureType({ name: 'a.bin', content_type: 'image/png' })).toBe('image/png');
    expect(formPictureType({ name: 'a.png', content_type: 'image/jpeg; charset=x' })).toBe('image/jpeg');
    expect(formPictureType({ name: 'a.svg', content_type: 'image/svg+xml' })).toBeNull();
    expect(formPictureType({ name: 'a.png', content_type: 'text/html' })).toBeNull();
    // From before the cut-over: served as octet-stream, typed by name.
    expect(formPictureType({ name: 'cover.jpg', content_type: 'application/octet-stream' })).toBe('image/jpeg');
    expect(formPictureType({ name: 'cover.webp' })).toBe('image/webp');
    expect(formPictureType({ name: 'photo.heic' })).toBe('image/heic');
    expect(formPictureType({ name: 'a.bin', content_type: 'image/avif' })).toBe('image/avif');
    expect(formPictureType({ name: 'notes.txt' })).toBeNull();
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
    expect(await imageUrlFor({ name: 'a.png', file_id: 'f-png', content_type: 'image/png' }, href)).toBe('blob:x');
    expect(await imageUrlFor({ name: 'b.svg', file_id: 'f-svg', content_type: 'image/svg+xml' }, href)).toBeNull();
    expect(fetched).toEqual(['/v2/files/f-png']);
    expect(blobs).toEqual(['image/png']);
  });
});
