import { describe, expect, it } from 'vitest';
import { ME, SELLER, historyPage, message } from '@/tests/support/chat-fixtures';
import { addMessages, highestSeq, markDeleted, messagesOf, unreadDividerId } from './message-cache';

const data = (...pages: ReturnType<typeof historyPage>[]) => ({ pages, pageParams: pages.map((_, index) => (index === 0 ? undefined : `c${index}`)) });

describe('Chat message cache helpers', () => {
  it('W05 AS-22: messages from all loaded pages are merged by id and ordered by seq whatever order the pages hold', () => {
    const cache = data(historyPage([message(5), message(3), message(4)], 'c1'), historyPage([message(2), message(1)]));
    expect(messagesOf(cache).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(messagesOf(undefined)).toEqual([]);
  });

  it('W05 AS-25: an incoming message is added to the newest page, a re-delivered one replaces its copy wherever it is', () => {
    const cache = data(historyPage([message(4), message(3)], 'c1'), historyPage([message(2), message(1)]));
    const next = addMessages(cache, [message(5), message(2, { body: 'edited' })]);
    expect(messagesOf(next).map((m) => [m.seq, m.body])).toEqual([[1, 'message 1'], [2, 'edited'], [3, 'message 3'], [4, 'message 4'], [5, 'message 5']]);
    expect(next?.pages[0]?.items.map((m) => m.seq)).toEqual([5, 4, 3]);
    expect(next?.pages[1]?.items.map((m) => m.seq)).toEqual([2, 1]);
    expect(next?.pages[0]?.nextCursor).toBe('c1');
  });

  it('W05 AS-25: adding nothing, or adding to a chat that is not loaded, changes nothing', () => {
    const cache = data(historyPage([message(1)]));
    expect(addMessages(cache, [])).toBe(cache);
    expect(addMessages(undefined, [message(1)])).toBeUndefined();
  });

  it('W05 AS-20: a deleted message becomes the tombstone in place (same seq, no body)', () => {
    const cache = data(historyPage([message(2), message(1)]));
    const next = markDeleted(cache, message(2).id);
    expect(messagesOf(next).map((m) => [m.seq, m.deleted, m.body])).toEqual([[1, false, 'message 1'], [2, true, null]]);
    expect(markDeleted(cache, 'unknown')).toBe(cache);
  });

  it('W05 AS-25: the highest seq held is the cursor of the catch-up (0 when nothing is held)', () => {
    expect(highestSeq(data(historyPage([message(7), message(6)])))).toBe(7);
    expect(highestSeq(undefined)).toBe(0);
  });

  it('W05 AS-12: the unread divider sits before the first of the other members\' n newest unread messages; own messages never count', () => {
    const list = [message(1), message(2, { authorId: ME }), message(3), message(4), message(5, { authorId: ME }), message(6)];
    // n = 2: the two newest messages from others are seq 6 and 4 -> the divider is before seq 4.
    expect(unreadDividerId(list, ME, 2)).toBe(message(4).id);
    expect(unreadDividerId(list, ME, 1)).toBe(message(6).id);
    expect(unreadDividerId(list, ME, 4)).toBe(message(1).id);
    expect(unreadDividerId(list, ME, 0)).toBeNull();
    // More unread than loaded: the divider sits before the oldest loaded one.
    expect(unreadDividerId(list, ME, 99)).toBe(message(1).id);
    expect(unreadDividerId([], ME, 3)).toBeNull();
    expect(unreadDividerId([message(1, { authorId: ME })], ME, 1)).toBeNull();
    expect(SELLER).toBeTruthy();
  });
});
