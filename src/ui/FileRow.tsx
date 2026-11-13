import type { WireFile } from '../state/types';
import { formatSize } from './format';
import { Icon } from './Icon';

/** A file in a message or chat. Downloads only, never rendered as a page (D-7d). */
export function FileRow(p: {
  file: WireFile;
  download: boolean;
  fileHref: (uploadId: string) => string;
  onRemove?: () => void;
}) {
  const f = p.file;
  let href: string | null = null;
  if (p.download && f.upload_id) href = p.fileHref(f.upload_id);
  if (p.download && f.data_base64 !== undefined) href = `data:application/octet-stream;base64,${f.data_base64}`;
  return (
    <div class="file">
      <Icon name="folder" />
      <span class="n">
        {f.name}
        <small>{formatSize(f.size)}</small>
      </span>
      {href && (
        <a class="dl" href={href} download={f.name}>
          Download
        </a>
      )}
      {p.onRemove && (
        <button type="button" class="rm" onClick={p.onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}
