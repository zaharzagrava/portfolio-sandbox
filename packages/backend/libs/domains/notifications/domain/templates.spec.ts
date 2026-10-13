import { NOTIFICATION_TYPES, type NotificationType } from './catalog';
import {
  BODY_MAX,
  PUSH_BODY_MAX,
  TITLE_MAX,
  interpolate,
  pickTemplate,
  render,
} from './templates';

const FRONT = 'https://shop.example';
const UUID = '3f2b8c1e-5d4a-4b7e-9c11-0a1b2c3d4e5f';
const order = (extra: Record<string, string> = {}) => ({
  orderId: UUID,
  orderShort: '3F2B8C1E',
  totalMinor: '129900',
  currency: 'USD',
  ...extra,
});

describe('S28 AS-78: interpolation and escaping (pure)', () => {
  const evil = '<script>alert(1)</script> & "Co"';

  it('HTML output escapes the value; plain text keeps the raw characters', () => {
    expect(interpolate('<p>{{title}}</p>', { title: evil }, true)).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;</p>',
    );
    expect(interpolate('Sold: {{title}}', { title: evil })).toBe(
      `Sold: ${evil}`,
    );
  });

  it('placeholders may have spaces inside the braces', () => {
    expect(interpolate('Hi {{ name }} and {{name}}', { name: 'Ann' })).toBe(
      'Hi Ann and Ann',
    );
  });

  it('a value that looks like a placeholder is not expanded again', () => {
    expect(interpolate('{{a}} {{b}}', { a: '{{b}}', b: 'secret' })).toBe(
      '{{b}} secret',
    );
  });

  it('the catalog escapes event data in the e-mail HTML but not in the plain text', () => {
    const rendered = render(
      'order.confirmed',
      'en',
      order({ orderShort: evil }),
      FRONT,
    );
    expect(rendered.emailHtml).not.toContain('<script>');
    expect(rendered.emailHtml).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;',
    );
    expect(rendered.body).toContain(evil);
  });
});

describe('S28 AS-79: a missing variable fails the render (pure)', () => {
  it('names the variable and returns no text', () => {
    expect(() => interpolate('Order {{orderShort}} is ready', {})).toThrow(
      /orderShort/,
    );
  });

  it('a catalog render without a required variable throws instead of sending half a message', () => {
    const { orderShort: _omitted, ...data } = order();
    expect(() => render('order.confirmed', 'en', data, FRONT)).toThrow(
      /orderShort/,
    );
  });
});

describe('S28 AS-80: locale fallback (pure)', () => {
  const type: NotificationType = 'order.confirmed';
  const en = pickTemplate(type, 'en');
  const uk = pickTemplate(type, 'uk');

  it('the two templates differ', () => {
    expect(uk.title).not.toBe(en.title);
  });

  it.each([
    ['uk-UA', uk],
    ['uk', uk],
    ['fr', en],
    ['en-GB', en],
    ['en', en],
    ['', en],
  ])('%s resolves to its language, else en', (locale, expected) => {
    expect(pickTemplate(type, locale)).toBe(expected);
  });
});

describe('S28 AS-82: header, length and link safety (pure)', () => {
  it('the subject has CR and LF removed', () => {
    const rendered = render(
      'order.cancelled',
      'en',
      order({
        reason: 'out_of_stock',
        orderShort: 'AB\r\nBcc: victim@example.com',
      }),
      FRONT,
    );
    expect(rendered.emailSubject).not.toMatch(/[\r\n]/);
    expect(rendered.emailSubject).toContain('Bcc: victim@example.com');
  });

  it('the inbox text is cut with an ellipsis, the push text to its own limit', () => {
    const rendered = render(
      'chat.message',
      'en',
      {
        channelId: UUID,
        channelTitle: 'T'.repeat(500),
        preview: 'x'.repeat(10_000),
      },
      FRONT,
    );
    expect(rendered.title).toHaveLength(TITLE_MAX);
    expect(rendered.title.endsWith('…')).toBe(true);
    expect(rendered.body).toHaveLength(BODY_MAX);
    expect(rendered.body.endsWith('…')).toBe(true);
    expect(rendered.pushBody.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    expect(rendered.pushBody.endsWith('…')).toBe(true);
  });

  it('short text is left alone', () => {
    const rendered = render('order.delivered', 'en', order(), FRONT);
    expect(rendered.body).toBe('Order 3F2B8C1E was delivered.');
    expect(rendered.pushBody).toBe(rendered.body);
  });

  it('the link comes from the catalog path template with validated identifiers', () => {
    const rendered = render('order.delivered', 'en', order(), FRONT);
    expect(rendered.link).toBe(`/orders/${UUID}`);
  });

  it.each([
    ['an absolute URL', 'https://evil.example'],
    ['a path traversal', '../admin'],
    ['a protocol-relative URL', '//evil.example'],
    ['a query', `${UUID}?next=https://evil.example`],
    ['a fragment', `${UUID}#x`],
    ['a space', `${UUID} x`],
    ['an empty id', ''],
  ])('an identifier that is %s fails the render', (_, orderId) => {
    expect(() =>
      render('order.delivered', 'en', order({ orderId }), FRONT),
    ).toThrow(/orderId/);
  });

  it('a safe slug is accepted (reset tokens, invite tokens)', () => {
    const rendered = render(
      'shop.invite',
      'en',
      { token: 'AbC_123-xyz', shopName: 'Shop', role: 'STAFF' },
      FRONT,
    );
    expect(rendered.link).toBe('/invites/AbC_123-xyz');
  });
});

describe('S28 AS-80/AS-87: every catalog row has an English and a Ukrainian template', () => {
  it.each(Object.keys(NOTIFICATION_TYPES) as NotificationType[])(
    '%s',
    (type) => {
      const en = pickTemplate(type, 'en');
      const uk = pickTemplate(type, 'uk');
      expect(en.title).toBeTruthy();
      expect(uk.title).toBeTruthy();
      expect(uk).not.toBe(en);
      expect(uk.title).toMatch(/[Ѐ-ӿ]/);
      // The same placeholders in both languages: a translation never drops or invents a variable.
      const vars = (t: { title: string; body: string }) =>
        [...`${t.title} ${t.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
          .map((m) => m[1])
          .sort();
      expect(new Set(vars(uk))).toEqual(new Set(vars(en)));
    },
  );
});
