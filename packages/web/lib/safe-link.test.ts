import { describe, expect, it } from 'vitest';
import { safeNotificationLink } from './safe-link';

describe('safeNotificationLink (W03 UL)', () => {
  it.each([
    ['/orders/9d8c7b6a', '/orders/9d8c7b6a'],
    ['/', '/'],
    ['/orders?cursor=abc', '/orders?cursor=abc'],
    ['/checkout/pay/1#top', '/checkout/pay/1#top'],
  ])('W03 AS-63: %s is a same-site path and is kept', (link, expected) => {
    expect(safeNotificationLink(link)).toBe(expected);
  });

  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['absolute https', 'https://evil.example/x'],
    ['absolute http', 'http://evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<b>x</b>'],
    ['backslash after slash', '/\\evil.example'],
    ['backslash anywhere', '/orders\\..\\x'],
    ['leading backslash', '\\\\evil.example'],
    ['no leading slash', 'orders/1'],
    ['scheme after slash-less', 'mailto:a@b.c'],
    ['tab inside', '/or\tders'],
    ['newline inside', '/orders\n/x'],
    ['carriage return', '/orders\r'],
    ['NUL', '/orders\u0000'],
    ['DEL', '/orders\u007f'],
    ['C1 control', '/orders\u0085'],
    ['leading space', ' /orders'],
    ['slash then space-slash', '/ /evil'],
    ['empty', ''],
  ])('W03 AS-63: %s is refused', (_label, link) => {
    expect(safeNotificationLink(link)).toBeNull();
  });

  it('W03 AS-63: an encoded slash is only a path character (the browser does not decode it into //)', () => {
    expect(safeNotificationLink('/%2F/evil')).toBe('/%2F/evil');
  });

  it.each([[null], [undefined], [42], [{}], [['/x']]])('W03 AS-63: a non-string (%j) is refused', (link) => {
    expect(safeNotificationLink(link as never)).toBeNull();
  });

  it('W03 AS-73: a very long path is refused (not a link a notification would carry)', () => {
    expect(safeNotificationLink(`/${'a'.repeat(2100)}`)).toBeNull();
  });
});
