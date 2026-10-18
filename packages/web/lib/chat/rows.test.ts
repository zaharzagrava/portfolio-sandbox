import { describe, expect, it } from 'vitest';
import { ME, SELLER, message } from '@/tests/support/chat-fixtures';
import type { PendingMessage } from './pending-messages';
import { buildRows } from './rows';

const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0)).getTime();
const pending = (id: string, body: string, over: Partial<PendingMessage> = {}): PendingMessage => ({ clientMessageId: id, body, replyToId: null, state: 'sending', ...over });
const base = { afterSeq: new Map<string, number>(), selfId: ME, dividerId: null, unread: 0, now: NOW };

describe('Chat rows', () => {
  it('W05 AS-12 AS-22: confirmed messages come in seq order and every pending bubble follows them in the order of sending', () => {
    const rows = buildRows({ ...base, confirmed: [message(1), message(2)], pending: [pending('a', 'first'), pending('b', 'second')] });
    expect(rows.map((row) => row.key)).toEqual([message(1).id, message(2).id, 'pending:a', 'pending:b']);
    expect(rows.map((row) => row.kind)).toEqual(['message', 'message', 'pending', 'pending']);
  });

  it('W05 AS-22: a day separator sits before the first message and wherever the local day changes', () => {
    const day1 = message(1, { createdAt: new Date(2026, 9, 9, 22, 0).toISOString() });
    const day1b = message(2, { createdAt: new Date(2026, 9, 9, 23, 0).toISOString() });
    const day2 = message(3, { createdAt: new Date(2026, 9, 10, 8, 0).toISOString() });
    const rows = buildRows({ ...base, now: new Date(2026, 9, 10, 12, 0).getTime(), confirmed: [day1, day1b, day2], pending: [] });
    expect(rows.map((row) => (row.kind === 'message' ? row.day : null))).toEqual(['Yesterday', null, 'Today']);
  });

  it('W05 AS-12: the "{n} new messages" separator is placed on the frozen divider message', () => {
    const rows = buildRows({ ...base, confirmed: [message(1), message(2), message(3)], pending: [], dividerId: message(2).id, unread: 2 });
    expect(rows.map((row) => (row.kind === 'message' ? row.divider : null))).toEqual([null, 2, null]);
  });

  it('W05 AS-14: a pending bubble disappears when its own message has arrived by sync or hint (same text, newer than when it was sent), so it is never shown twice', () => {
    const arrived = message(4, { authorId: ME, body: 'hello' });
    const rows = buildRows({ ...base, afterSeq: new Map([['a', 3]]), confirmed: [message(3), arrived], pending: [pending('a', 'hello')] });
    expect(rows.map((row) => row.key)).toEqual([message(3).id, arrived.id]);
  });

  it('W05 AS-16: a "Not sent" bubble whose message did arrive anyway (the request had in fact succeeded) is not shown', () => {
    const arrived = message(4, { authorId: ME, body: 'hello' });
    const rows = buildRows({ ...base, afterSeq: new Map([['a', 3]]), confirmed: [message(3), arrived], pending: [pending('a', 'hello', { state: 'failed', failure: 'network' })] });
    expect(rows.some((row) => row.kind === 'pending')).toBe(false);
  });

  it('W05 AS-14: an older identical message, another author or another text does not hide a bubble; each message hides at most one bubble', () => {
    const older = message(2, { authorId: ME, body: 'ok' });
    const other = message(5, { authorId: SELLER, body: 'ok' });
    const kept = buildRows({ ...base, afterSeq: new Map([['a', 3]]), confirmed: [older, other], pending: [pending('a', 'ok')] });
    expect(kept.some((row) => row.kind === 'pending')).toBe(true);
    const twin = message(6, { authorId: ME, body: 'ok' });
    const two = buildRows({ ...base, afterSeq: new Map([['a', 3], ['b', 3]]), confirmed: [twin], pending: [pending('a', 'ok'), pending('b', 'ok')] });
    expect(two.filter((row) => row.kind === 'pending').map((row) => row.key)).toEqual(['pending:b']);
  });
});
