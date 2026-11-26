import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';
import type { WireFile } from '../state/types';
import { formatSize } from './format';
import { Icon } from './Icon';

export const DownloadBytes = createContext<((id: string) => Promise<ArrayBuffer> | undefined) | undefined>(undefined);

/** A file in a message or chat. Downloads only, never rendered as a page (D-7d). */
export function FileRow(p: {
  file: WireFile;
  download: boolean;
  fileHref: (uploadId: string) => string | null;
  onRemove?: () => void;
}) {
  const f = p.file;
  const downloadBytes = useContext(DownloadBytes);
  const [failed, setFailed] = useState(false);
  const download = () => {
    const pending = f.file_id && downloadBytes?.(f.file_id);
    if (!pending) return;
    setFailed(false);
    void pending.then((bytes) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = f.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }).catch(() => setFailed(true));
  };
  let href: string | null = null;
  if (p.download && f.file_id) href = p.fileHref(f.file_id);
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
      {!href && p.download && f.file_id && downloadBytes && (
        <button type="button" class="dl" onClick={download}>Download</button>
      )}
      {failed && <small role="status">Download failed</small>}
      {p.onRemove && (
        <button type="button" class="rm" onClick={p.onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}
