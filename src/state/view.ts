// The inbox view: the order and grouping the inbox is
// drawn in, as the iPhone app draws it, built from each item's rank (v2/model).

export interface ViewEntry {
  key: string;
  thread: string | null;
  priority: 'urgent' | 'high' | null;
}

export type FreeState = 'active' | 'history';
export type FreeGroup = 'common' | 'earlier_messages' | 'earlier_chat_replies' | 'earlier_chat_replies_unknown';

export interface FreeSection {
  state: FreeState;
  group: FreeGroup;
}

export type ListItem =
  | { kind: 'message'; key: string; section: FreeSection | null }
  | {
      kind: 'reply';
      key: string;
      section: FreeSection | null;
      conversationSeq: number;
      openAt: number;
      unseen: number | null;
      historical: boolean;
      priority: 'urgent' | 'high' | null;
    };

export interface ServerView {
  entries: ViewEntry[];
  /** Null when the Server sent no list_items. */
  listItems: ListItem[] | null;
  /** Free order is on: every item has a valid section, in order. */
  freeOrder: boolean;
}

const STATES: FreeState[] = ['active', 'history'];
const GROUPS: FreeGroup[] = ['common', 'earlier_messages', 'earlier_chat_replies', 'earlier_chat_replies_unknown'];

/** Free order applies only when every item has a section, sections never go
 * backwards, and each group holds its own kind of item. */
export function freeOrderValid(version: number | null, items: ListItem[]): boolean {
  if (version !== 1) return false;
  let last = -1;
  for (const it of items) {
    if (!it.section) return false;
    const pos = STATES.indexOf(it.section.state) * 10 + GROUPS.indexOf(it.section.group);
    if (pos < last) return false;
    last = pos;
    const g = it.section.group;
    if (g === 'earlier_messages' && it.kind !== 'message') return false;
    if ((g === 'earlier_chat_replies' || g === 'earlier_chat_replies_unknown') && it.kind !== 'reply') return false;
  }
  return true;
}
