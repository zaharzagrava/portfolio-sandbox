import type { ChatMessage } from '@marketplace-sandbox/contracts';
import type { PendingMessage } from './pending-messages';
import { dayKey, dayLabel } from './time-format';

/**
 * The rows of the message list (W05 FR-012, AS-12, AS-14, AS-22): confirmed messages in `seq` order, each with the day
 * separator or the "{n} new messages" separator that sits before it, then the pending bubbles in the order of sending.
 *
 * A bubble is hidden once its own message has reached the page by another road (a live hint or a sync that beat the answer
 * of the send, or a request that had in fact succeeded): a message of the member's own, with the same text and reply
 * reference, whose `seq` is above everything held when the bubble was made. Each message hides at most one bubble. So a
 * message is never on screen twice, whichever answer arrives first.
 */
export type MessageRow = { key: string; kind: 'message'; message: ChatMessage; day: string | null; divider: number | null };
export type PendingRow = { key: string; kind: 'pending'; item: PendingMessage };
export type Row = MessageRow | PendingRow;

export function buildRows(input: {
  confirmed: ChatMessage[];
  pending: PendingMessage[];
  /** For each pending `clientMessageId`: the highest `seq` held when it was made. */
  afterSeq: ReadonlyMap<string, number>;
  selfId: string | null;
  /** The message the unread separator sits before, frozen when the chat opened. */
  dividerId: string | null;
  unread: number;
  now: number;
}): Row[] {
  const rows: Row[] = [];
  let previousDay = '';
  for (const message of input.confirmed) {
    const day = dayKey(message.createdAt);
    rows.push({
      key: message.id,
      kind: 'message',
      message,
      day: day !== previousDay ? dayLabel(message.createdAt, input.now) : null,
      divider: message.id === input.dividerId ? input.unread : null,
    });
    previousDay = day;
  }

  const claimed = new Set<string>();
  for (const item of input.pending) {
    const after = input.afterSeq.get(item.clientMessageId) ?? Number.POSITIVE_INFINITY;
    const arrived = input.confirmed.find(
      (message) => !claimed.has(message.id) && message.authorId === input.selfId && message.seq > after && message.body === item.body && message.replyToId === item.replyToId,
    );
    if (arrived) {
      claimed.add(arrived.id);
      continue;
    }
    rows.push({ key: `pending:${item.clientMessageId}`, kind: 'pending', item });
  }
  return rows;
}
