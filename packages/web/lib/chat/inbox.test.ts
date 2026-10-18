import { describe, expect, it } from 'vitest';
import { CH1, CH2, CH3, inboxItem, inboxPage } from '@/tests/support/chat-fixtures';
import { inboxItems, unreadLabel, unreadName, unreadSum } from './inbox';

describe('Inbox helpers', () => {
  it('W05 AS-09: pages flatten in order and each chat appears once (the first copy wins)', () => {
    const data = {
      pages: [inboxPage([inboxItem({ id: CH1, unread: 1 }), inboxItem({ id: CH2 })], 'c'), inboxPage([inboxItem({ id: CH2, unread: 9 }), inboxItem({ id: CH3 })])],
      pageParams: [undefined, 'c'],
    };
    expect(inboxItems(data).map((item) => [item.id, item.unread])).toEqual([[CH1, 1], [CH2, 0], [CH3, 0]]);
    expect(inboxItems(undefined)).toEqual([]);
  });

  it('W05 AS-07: the badge shows the number, 99+ above 99, with the accessible name "{n} unread messages"', () => {
    expect(unreadLabel(5)).toBe('5');
    expect(unreadLabel(99)).toBe('99');
    expect(unreadLabel(100)).toBe('99+');
    expect(unreadName(1)).toBe('1 unread message');
    expect(unreadName(150)).toBe('150 unread messages');
  });

  it('W05 AS-11: the total is the sum of the unread numbers on the page', () => {
    expect(unreadSum([inboxItem({ unread: 2 }), inboxItem({ unread: 3 })])).toBe(5);
    expect(unreadSum([])).toBe(0);
  });
});
