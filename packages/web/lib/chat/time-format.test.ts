import { describe, expect, it } from 'vitest';
import { authorLabel, dayKey, dayLabel, inboxTime, messageTime } from './time-format';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0).toISOString();
const NOW = new Date(2026, 9, 17, 15, 30, 0).getTime();

describe('Chat time and author labels', () => {
  it('W05 AS-07: the last message time reads "just now", "{n} min ago", today\'s clock time, or a date', () => {
    expect(inboxTime(new Date(NOW - 20_000).toISOString(), NOW)).toBe('Just now');
    expect(inboxTime(new Date(NOW - 2 * 60_000).toISOString(), NOW)).toBe('2 min ago');
    expect(inboxTime(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe('59 min ago');
    expect(inboxTime(at(2026, 10, 17, 9, 5), NOW)).toBe(new Date(2026, 9, 17, 9, 5).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(inboxTime(at(2026, 10, 10, 9, 5), NOW)).toBe(new Date(2026, 9, 10, 9, 5).toLocaleDateString([], { month: 'short', day: 'numeric' }));
    expect(inboxTime(at(2025, 10, 10, 9, 5), NOW)).toBe(new Date(2025, 9, 10, 9, 5).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }));
  });

  it('W05 AS-07: no last message means no time, and an unreadable instant means no time', () => {
    expect(inboxTime(null, NOW)).toBe('');
    expect(inboxTime('not a date', NOW)).toBe('');
  });

  it('W05 AS-22: day separators read Today, Yesterday, or a date, and the key changes at local midnight', () => {
    expect(dayLabel(at(2026, 10, 17, 0, 1), NOW)).toBe('Today');
    expect(dayLabel(at(2026, 10, 16, 23, 59), NOW)).toBe('Yesterday');
    expect(dayLabel(at(2026, 10, 1), NOW)).toBe(new Date(2026, 9, 1).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
    expect(dayKey(at(2026, 10, 16, 23, 59))).not.toBe(dayKey(at(2026, 10, 17, 0, 1)));
    expect(dayKey(at(2026, 10, 17, 0, 1))).toBe(dayKey(at(2026, 10, 17, 23, 59)));
  });

  it('W05 AS-22: a message shows its clock time', () => {
    expect(messageTime(at(2026, 10, 17, 9, 5))).toBe(new Date(2026, 9, 17, 9, 5).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });

  it('W05 AS-22: author labels are You, Seller (the chat\'s sellerId) or Buyer plus the first 4 characters of the id', () => {
    const ids = { selfId: 'aaaa1111', sellerId: 'bbbb2222' };
    expect(authorLabel('aaaa1111', ids)).toBe('You');
    expect(authorLabel('bbbb2222', ids)).toBe('Seller');
    expect(authorLabel('cccc3333-0000', ids)).toBe('Buyer cccc');
    expect(authorLabel('aaaa1111', { selfId: 'aaaa1111', sellerId: 'aaaa1111' })).toBe('You');
  });
});
