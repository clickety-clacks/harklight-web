// Domain types for the web client. They mirror what the device relay carries;
// the web client keeps them in memory for one tab only.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  /** The sign-in ended (4401). The tab leaves for sign-in. */
  | 'ended'
  /** The account cannot use messaging (4403 or inactive_account). */
  | 'inactive'
  /** A client defect (1008) or a protocol failure that a retry will not fix. */
  | 'failed';

/** sender_id + message_id; the identity of one message. */
export interface MessageKey {
  sender_id: string;
  message_id: string;
}

export function keyOf(k: MessageKey): string {
  return `${k.sender_id}\u0000${k.message_id}`;
}

export function splitKey(key: string): MessageKey {
  const i = key.indexOf('\u0000');
  return { sender_id: key.slice(0, i), message_id: key.slice(i + 1) };
}

export type LifecycleState = 'answered' | 'no_comment' | 'cleared' | 'expired' | 'superseded';

export interface AnswerOutcome {
  kind: 'seen' | 'reply' | 'no_comment' | 'default';
  text?: string;
  value?: Json;
}

export interface Terminal {
  state: LifecycleState;
  seq: number;
  retracted: boolean;
  outcome: AnswerOutcome | null;
}

export interface WireFile {
  name: string;
  size?: number;
  sha256?: string;
  data_base64?: string;
  upload_id?: string;
  /** Client API v2: the id the file is read by (GET /v2/files/{id}). */
  file_id?: string;
  content_type?: string;
}

/** One message as the inbox holds it. */
export interface HeldMessage extends MessageKey {
  /** The sender's message payload, latest revision. */
  payload: JsonObject;
  revision: number;
  /** Sequence of the delivery that accepted it; newer is higher. */
  acceptedSeq: number;
  terminal: Terminal | null;
  files: WireFile[];
  /** Revision 1's files, which custom answer forms' images name. */
  firstFiles: WireFile[];
  /** The agent opened a chat for this message (delivery carries session_handle). */
  chat: boolean;
  /** Held only when the message came over client API v2. */
  v2?: V2Item;
}

/** What client API v2 adds to a held message: its resource version, its
 * place in the inbox and its chat read state. */
export interface V2Item {
  item_id: string;
  /** The change that last wrote the item; a snapshot or change applies only if newer. */
  rev: number;
  /** Inbox order: ascending by code point (UTF-8 byte order). */
  rankKey: string;
  score: number | null;
  seen: boolean;
  /** entry_id the person has read through, and the newest origin reply. */
  readPosition: string | null;
  lastOriginReply: string | null;
  availability: Availability;
  /** Present when this client is a recipient rather than the item's origin. */
  as: 'message' | 'knock' | null;
  /** The item's terminal state as the Server sent it. */
  terminal: { state: string; no_comment: boolean } | null;
}

export type TurnAuthor = 'person' | 'origin' | 'agent' | 'server';

export interface Turn {
  /** event_id when known, else a local id. */
  id: string;
  seq: number | null;
  kind: string;
  author: TurnAuthor;
  text: string;
  files: WireFile[];
  revision: number;
  op_id?: string;
  in_reply_to?: string;
  /** Client API v2: the entry's resource version (entries are upserted by rev). */
  rev?: number;
  /** Client API v2: active, withdrawn or retracted. */
  state?: string;
}

export type Availability = 'listening' | 'not_listening' | 'unsupported' | 'gone' | null;

export interface Thread {
  key: string;
  turns: Turn[];
  availability: Availability;
  retracted: boolean;
  /** Event ids of person turns the agent has received. */
  delivered: Set<string>;
  /** Conversation sequences already applied, so a replay never doubles a turn. */
  applied: Set<number>;
}

/** A pending chat send from this tab. */
export interface ChatSend {
  op_id: string;
  key: string;
  revision: number;
  text: string;
  files: PickedFile[];
  state: 'sending' | 'sent' | 'failed' | 'closed';
  reason?: string;
}

export interface PickedFile {
  id: string;
  name: string;
  size: number;
  file: Blob;
}
