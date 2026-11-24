// Domain types for the web client, filled from client API v2 resources;
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
  kind: 'seen' | 'reply' | 'no_comment' | 'default' | 'choice' | 'result';
  text?: string;
  value?: Json;
  /** kind choice (client API v2): the matched answer action. */
  choice?: { id: string; label: string };
}

/** A person's message or answer reached the agent, could not be handed to it, or neither is known. */
export type Receipt = 'delivered' | 'not_handed' | null;

export interface Terminal {
  state: LifecycleState;
  seq: number;
  retracted: boolean;
  outcome: AnswerOutcome | null;
  /** What became of the answer's handoff to the agent. */
  receipt?: Receipt;
}

export interface WireFile {
  name: string;
  size?: number;
  sha256?: string;
  /** The id the file is read by (GET /v2/files/{id}); absent on a file still being picked. */
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
  /** The files available to the item's custom answer form. */
  firstFiles: WireFile[];
  /** The item has a conversation (Chat.available). */
  chat: boolean;
  /** Resource state supplied by client API v2. */
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
  createdAt?: number;
  score: number | null;
  seen: boolean;
  /** entry_id the person has read through, and the newest origin reply. */
  readPosition: string | null;
  lastOriginReply: string | null;
  availability: Availability;
  /** Present when this client is a recipient rather than the item's origin. */
  as: 'message' | 'knock' | null;
  /** Agent chat replies after the read position, as the Server counts them. */
  unreadReplies: number | null;
  /** The inbox section: History is drawn for `resolved`. */
  section: 'current' | 'resolved' | null;
  /** The free-order group of a current item. */
  group: 'common' | 'earlier_messages' | null;
  /** The unread-reply row's group and sort key, while there are unread replies. */
  replyGroup: 'earlier_chat_replies' | 'earlier_chat_replies_unknown' | null;
  replyRankKey: string | null;
  /** The effective thread group (with the sender, the group key). */
  thread: string | null;
  /** The item's priority level (Rank.level) and its reply row's (Chat.reply_priority.level). */
  level: 'now' | 'high' | 'normal' | 'low' | null;
  replyScore: number | null;
  replyLevel: 'now' | 'high' | 'normal' | 'low' | null;
}

export type TurnAuthor = 'person' | 'origin' | 'agent' | 'server';

export interface Turn {
  result?: import('../v2/wire').OriginResult;
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
  /** The person's turn: what became of its handoff, as of this rev. */
  receipt?: Receipt;
  /** Client API v2: active, withdrawn or retracted. */
  state?: string;
}

export type Availability = 'listening' | 'not_listening' | 'unsupported' | 'gone' | null;

export interface Thread {
  key: string;
  turns: Turn[];
  availability: Availability;
  retracted: boolean;
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
  /** Client API v2: a person turn already in the chat that looks like this
   * send. It is hidden while sending, so it never shows twice, but only its own
   * response settles it: the turn may be the same text from another device. */
  lookalike?: string;
}

export interface PickedFile {
  id: string;
  name: string;
  size: number;
  file: Blob;
}
