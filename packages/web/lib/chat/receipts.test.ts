import type { ChatMessage } from '@marketplace-sandbox/contracts';
import { describe, expect, it } from 'vitest';
import { applyReadEvent, positionsFromReceipts, seenByCount, seenLabel, seenUnder } from './receipts';

const ME = 'a0000000-0000-4000-8000-00000000000a';
const U1 = 'a0000000-0000-4000-8000-000000000001';
const U2 = 'a0000000-0000-4000-8000-000000000002';
const msg = (seq: number, authorId: string): ChatMessage => ({ id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, seq, authorId, body: `m${seq}`, replyToId: null, createdAt: '2026-10-01T10:00:00.000Z', deleted: false });

describe('Receipts', () => {
  it('W05 AS-33 UC11: "Seen by" counts the distinct other readers whose position is at or past the message seq', () => {
    const positions = { [U1]: 5, [U2]: 4 };
    expect(seenByCount(positions, 5, ME)).toBe(1);
    expect(seenByCount(positions, 4, ME)).toBe(2);
    expect(seenByCount(positions, 6, ME)).toBe(0);
    expect(seenByCount({}, 1, ME)).toBe(0);
  });

  it('W05 AS-33 UC11: the member\'s own position never counts', () => {
    expect(seenByCount({ [ME]: 99, [U1]: 1 }, 5, ME)).toBe(0);
    expect(seenByCount({ [ME]: 99, [U1]: 7 }, 5, ME)).toBe(1);
  });

  it('W05 AS-33 UC11: the label is "Seen" for one reader, "Seen by n" for more, and nothing for none', () => {
    expect(seenLabel(0)).toBeNull();
    expect(seenLabel(1)).toBe('Seen');
    expect(seenLabel(2)).toBe('Seen by 2');
    expect(seenLabel(12)).toBe('Seen by 12');
  });

  it('W05 AS-33 UC11: a read event raises a position and never lowers it (a late or repeated event changes nothing)', () => {
    const start = { [U1]: 5 };
    expect(applyReadEvent(start, { userId: U1, seq: 9 })).toEqual({ [U1]: 9 });
    expect(applyReadEvent(start, { userId: U1, seq: 3 })).toBe(start);
    expect(applyReadEvent(start, { userId: U2, seq: 2 })).toEqual({ [U1]: 5, [U2]: 2 });
    expect(start).toEqual({ [U1]: 5 });
  });

  it('W05 AS-33 UC11: the starting positions come from the receipts answer, without the member, and a suppressed answer has none', () => {
    expect(positionsFromReceipts({ items: [{ userId: ME, lastReadSeq: 9 }, { userId: U1, lastReadSeq: 3 }], suppressed: false }, ME)).toEqual({ positions: { [U1]: 3 }, suppressed: false });
    expect(positionsFromReceipts({ items: [{ userId: U1, lastReadSeq: 3 }], suppressed: true }, ME)).toEqual({ positions: {}, suppressed: true });
    expect(positionsFromReceipts(undefined, ME)).toEqual({ positions: {}, suppressed: false });
  });

  it('W05 AS-33 UC11: the label sits under the member\'s own newest message that others have read; nothing when no data says so', () => {
    const messages = [msg(1, U1), msg(2, ME), msg(3, U1), msg(4, ME), msg(5, U1)];
    expect(seenUnder(messages, { [U1]: 4 }, ME, false)).toEqual({ messageId: messages[3].id, label: 'Seen' });
    expect(seenUnder(messages, { [U1]: 2, [U2]: 3 }, ME, false)).toEqual({ messageId: messages[1].id, label: 'Seen by 2' });
    expect(seenUnder(messages, { [U1]: 1 }, ME, false)).toBeNull();
    expect(seenUnder(messages, {}, ME, false)).toBeNull();
    expect(seenUnder([msg(1, U1)], { [U1]: 9 }, ME, false)).toBeNull();
    expect(seenUnder([], { [U1]: 9 }, ME, false)).toBeNull();
  });

  it('W05 AS-33 UC11: in a large chat (suppressed) nothing is shown, whatever the events say', () => {
    expect(seenUnder([msg(1, ME)], { [U1]: 9 }, ME, true)).toBeNull();
  });

  it('W05 AS-33 UC11: a deleted message of the member does not carry the label', () => {
    expect(seenUnder([{ ...msg(1, ME), deleted: true, body: null }, msg(2, U1)], { [U1]: 9 }, ME, false)).toBeNull();
  });
});
