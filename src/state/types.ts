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
