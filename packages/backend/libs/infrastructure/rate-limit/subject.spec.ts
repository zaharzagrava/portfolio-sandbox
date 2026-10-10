import { createHash } from 'node:crypto';
import {
  EMPTY_EMAIL_SUBJECT,
  customSubject,
  emailSubject,
  resolveSubject,
} from './subject';

const sha = (v: string) =>
  createHash('sha256').update(v).digest('hex').slice(0, 32);

describe('S50 subject', () => {
  it('S50 AS-51: e-mail variants of one address map to one subject, a hash only', () => {
    const a = emailSubject('  Alice@Example.COM ');
    const b = emailSubject('alice@example.com');
    expect(a).toBe(b);
    expect(a).toBe(`email:${sha('alice@example.com')}`);
    expect(a).toMatch(/^email:[0-9a-f]{32}$/);
    expect(a).not.toContain('alice');
  });

  it('S50 AS-51: different addresses map to different subjects', () => {
    expect(emailSubject('a@x.io')).not.toBe(emailSubject('b@x.io'));
  });

  it.each([undefined, null, '', '   ', 42, {}, ['a@b.c']])(
    'S50 AS-51: missing or non-string e-mail %p maps to the one fixed empty subject',
    (value) => {
      expect(emailSubject(value)).toBe(EMPTY_EMAIL_SUBJECT);
    },
  );

  it('S50 AS-53: a custom value up to 128 characters is used as given', () => {
    const v = 'x'.repeat(128);
    expect(customSubject(v)).toBe(`custom:${v}`);
    expect(customSubject('tenant-9')).toBe('custom:tenant-9');
  });

  it('S50 AS-53: a longer value is replaced by its hash', () => {
    const v = 'y'.repeat(129);
    const s = customSubject(v);
    expect(s).toBe(`custom:${sha(v)}`);
    expect(s).not.toContain('yyyy');
  });

  it('S50 AS-53: a value with hash-tag characters is hashed so it cannot break the key', () => {
    const v = 'a}b{c';
    expect(customSubject(v)).toBe(`custom:${sha(v)}`);
  });

  it.each([undefined, null, ''])(
    'S50 AS-53: extractor returning %p falls back to the address',
    (value) => {
      const r = resolveSubject('custom', { clientIp: '1.2.3.4' }, () => value);
      expect(r).toEqual({ subject: 'ip:1.2.3.4', fellBack: true });
    },
  );

  it('S50 AS-49: typed subjects per source', () => {
    const req = {
      clientIp: '9.9.9.9',
      user: { id: 'u1' },
      apiKey: { id: 'k1', shopId: 's1' },
      shopId: 's2',
      body: { email: 'A@b.c' },
    };
    expect(resolveSubject('ip', req).subject).toBe('ip:9.9.9.9');
    expect(resolveSubject('user', req).subject).toBe('user:u1');
    expect(resolveSubject('userOrIp', req).subject).toBe('user:u1');
    expect(resolveSubject('apiKey', req).subject).toBe('key:k1');
    expect(resolveSubject('shop', req).subject).toBe('shop:s1');
    expect(resolveSubject('body.email', req).subject).toBe(
      `email:${sha('a@b.c')}`,
    );
  });

  it('S50 AS-50: a missing identity falls back to the address and says so', () => {
    const req = { clientIp: '9.9.9.9' };
    expect(resolveSubject('user', req)).toEqual({
      subject: 'ip:9.9.9.9',
      fellBack: true,
    });
    expect(resolveSubject('apiKey', req).fellBack).toBe(true);
    expect(resolveSubject('shop', req).fellBack).toBe(true);
    expect(resolveSubject('userOrIp', req).fellBack).toBe(false);
    expect(resolveSubject('ip', req).fellBack).toBe(false);
  });

  it('S50 AS-48: forwarding headers are never read, only the resolved address', () => {
    const req = {
      clientIp: '5.5.5.5',
      headers: { 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '7.7.7.7' },
    };
    expect(resolveSubject('ip', req).subject).toBe('ip:5.5.5.5');
  });
});
