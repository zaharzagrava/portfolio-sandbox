import type { ChatMessage, ChatReceipts } from '@marketplace-sandbox/contracts';

/**
 * "Seen by" (W05 FR-044, AS-33). Positions of the other members come from `read {userId, seq}` events and from the receipts
 * answer read when a small chat opens; a reader counts when their position is at or past the message's `seq`; the member's
 * own position never counts; no data means no label, never a guess; a large chat (suppressed) shows nothing.
 */

export type Positions = Record<string, number>;

export function seenByCount(positions: Positions, seq: number, selfId: string): number {
  let count = 0;
  for (const [userId, position] of Object.entries(positions)) if (userId !== selfId && position >= seq) count += 1;
  return count;
}

export function seenLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? 'Seen' : `Seen by ${count}`;
}

/** A read event raises a position and never lowers it. The same object comes back when nothing changes. */
export function applyReadEvent(positions: Positions, event: { userId: string; seq: number }): Positions {
  if ((positions[event.userId] ?? -1) >= event.seq) return positions;
  return { ...positions, [event.userId]: event.seq };
}

export function positionsFromReceipts(receipts: ChatReceipts | undefined, selfId: string): { positions: Positions; suppressed: boolean } {
  if (!receipts) return { positions: {}, suppressed: false };
  if (receipts.suppressed) return { positions: {}, suppressed: true };
  const positions: Positions = {};
  for (const item of receipts.items) if (item.userId !== selfId) positions[item.userId] = Math.max(positions[item.userId] ?? 0, item.lastReadSeq);
  return { positions, suppressed: false };
}

/** The label under the member's newest own message that someone else has read; `null` when there is none to show. */
export function seenUnder(messages: ChatMessage[], positions: Positions, selfId: string, suppressed: boolean): { messageId: string; label: string } | null {
  if (suppressed) return null;
  const own = messages.filter((message) => message.authorId === selfId && !message.deleted).sort((a, b) => b.seq - a.seq);
  for (const message of own) {
    const label = seenLabel(seenByCount(positions, message.seq, selfId));
    if (label) return { messageId: message.id, label };
  }
  return null;
}
