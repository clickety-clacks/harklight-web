// What the UI asks of the tab's connection to the Server: the client API v2
// session (src/v2/session.ts) provides it.

import type { State } from './state/store';
import type { ChatSend, HeldMessage, Json } from './state/types';

export interface ClientSession {
  start(): void;
  stop(): void;
  /** Try now instead of waiting, for example when the network comes back. */
  nudge(): void;
  /** After a failure a retry will not fix: start again, keeping what the tab holds. */
  tryAgain(): void;
  loadMore(): Promise<void>;
  messageOpened(m: HeldMessage): void;
  answer(m: HeldMessage, value: Json, label: string | null, opts?: { seen?: boolean; control: string; text?: string; draft?: unknown }): Promise<void>;
  noComment(m: HeldMessage): Promise<void>;
  retryAnswer(key: string): void;
  editFailedAnswer(key: string): void;
  chat(m: HeldMessage, text: string, files: ChatSend['files']): Promise<void>;
  retryChat(opId: string): void;
  discardChat(opId: string): void;
  removeChatFile?(opId: string, fileId: string): void;
  markRead(key: string, seq: number): void;
  /** Whether answers and chat can be sent now. */
  canWrite(s: State): boolean;
  /** Where a file is downloaded from, by the id the message carries. */
  fileHref(id: string): string;
  pictureBytes(id: string): Promise<ArrayBuffer>;
}
