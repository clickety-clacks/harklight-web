// The caption under a chat turn the person sent: what is known of it reaching
// the agent. The words are the iPhone app's.

import type { Availability, Turn } from './types';

export interface Caption {
  text: string;
  /** Draws the check. */
  ok?: boolean;
  /** A failure: draws the warning. */
  bad?: boolean;
}

const DELIVERED: Caption = { text: 'Delivered', ok: true };
const NO_ONE: Caption = { text: 'No one will get this', bad: true };

/** A current agent reply to this very turn. */
function hasReply(turn: Turn, turns: Turn[]): boolean {
  return turns.some((r) => r.kind === 'reply' && r.author === 'origin' && r.in_reply_to === turn.id && r.state !== 'withdrawn' && r.state !== 'retracted');
}

/**
 * First match wins. The Server's own `delivered` and `acted` are not evidence
 * that the agent has the turn, except on a turn it marks `legacy_caption`
 * (older Servers). A turn on which no receipt is expected (newer Servers) shows
 * no caption until evidence arrives. Nothing here depends on the time.
 */
export function captionOf(turn: Turn, turns: Turn[], availability: Availability): Caption | null {
  const d = turn.delivery ?? {};
  const unreachable = availability === 'gone' || availability === 'unsupported';
  if (d.agent_seen || d.agent_acted || hasReply(turn, turns)) return DELIVERED;
  if (d.outcome === 'handed') return d.rerouted && d.agent ? { text: `Delivered to ${d.agent}`, ok: true } : DELIVERED;
  if (d.outcome === 'not_handed') {
    if (unreachable) return NO_ONE;
    return { text: d.reason?.trim() ? `Not delivered: ${d.reason}` : 'Not delivered', bad: true };
  }
  if (d.receipt_expected === false) return null;
  if (d.ack2_expected === false) {
    if (d.listener_received) return DELIVERED;
  } else if (d.legacy_caption) {
    return d.delivered || d.acted ? DELIVERED : { text: 'Sent' };
  }
  if (unreachable) return NO_ONE;
  if (d.delivered) return { text: 'Sending…' };
  return { text: availability === 'not_listening' ? 'Not delivered yet' : 'Sent' };
}
