import {
  normalizeEndpointUrl,
  parseEndpointUrl,
  WEBHOOK_URL_MAX_LENGTH,
} from './webhook-url';

describe('webhook endpoint URL rules (pure)', () => {
  it.each<[string, string]>([
    ['no scheme', 'hooks.acme.test/in'],
    ['not a URL at all', 'not a url'],
    ['only a scheme', 'https://'],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('S43 AS-02: syntactic parse refuses %s as malformed', (_name, raw) => {
    expect(parseEndpointUrl(raw)).toEqual({
      ok: false,
      failure: { kind: 'malformed' },
    });
  });

  it('S43 AS-02: a value that is not a string is malformed', () => {
    expect(parseEndpointUrl(42 as unknown as string)).toEqual({
      ok: false,
      failure: { kind: 'malformed' },
    });
    expect(parseEndpointUrl(undefined as unknown as string)).toEqual({
      ok: false,
      failure: { kind: 'malformed' },
    });
  });

  it('S43 AS-02: URL length is limited to 2,048 characters, inclusive', () => {
    const prefix = 'https://hooks.acme.test/';
    const atLimit = prefix + 'a'.repeat(WEBHOOK_URL_MAX_LENGTH - prefix.length);
    expect(atLimit).toHaveLength(2048);
    expect(parseEndpointUrl(atLimit).ok).toBe(true);
    expect(parseEndpointUrl(atLimit + 'a')).toEqual({
      ok: false,
      failure: { kind: 'too_long' },
    });
  });

  it.each<[string, string, string]>([
    ['plain http', 'http://hooks.acme.test/in', 'not_https'],
    ['ftp', 'ftp://hooks.acme.test/in', 'not_https'],
    [
      'user and password',
      'https://user:pw@hooks.acme.test/in',
      'credentials_not_allowed',
    ],
    ['user only', 'https://user@hooks.acme.test/in', 'credentials_not_allowed'],
    ['port 8443', 'https://hooks.acme.test:8443/in', 'port_not_allowed'],
    ['port 80', 'https://hooks.acme.test:80/in', 'port_not_allowed'],
    ['IPv4 literal', 'https://203.0.113.9/in', 'ip_literal'],
    ['IPv6 literal', 'https://[2001:db8::1]/in', 'ip_literal'],
    ['IPv4-mapped IPv6 literal', 'https://[::ffff:10.0.0.5]/in', 'ip_literal'],
    ['decimal IPv4 form', 'https://2130706433/in', 'ip_literal'],
    ['hexadecimal IPv4 form', 'https://0x7f000001/in', 'ip_literal'],
    ['localhost', 'https://localhost/in', 'blocked_address'],
    ['LOCALHOST upper case', 'https://LOCALHOST/in', 'blocked_address'],
    ['a name under localhost', 'https://api.localhost/in', 'blocked_address'],
    [
      'localhost with a trailing dot',
      'https://localhost./in',
      'blocked_address',
    ],
  ])('S43 AS-03: %s is refused with reason %s', (_name, raw, reason) => {
    expect(parseEndpointUrl(raw)).toEqual({
      ok: false,
      failure: { kind: 'rejected', reason },
    });
  });

  it('S43 AS-03: the scheme is checked before credentials, credentials before the port, the port before the host', () => {
    expect(parseEndpointUrl('http://u:p@h.test:81/')).toMatchObject({
      failure: { reason: 'not_https' },
    });
    expect(parseEndpointUrl('https://u:p@h.test:81/')).toMatchObject({
      failure: { reason: 'credentials_not_allowed' },
    });
    expect(parseEndpointUrl('https://h.test:81/')).toMatchObject({
      failure: { reason: 'port_not_allowed' },
    });
  });

  it.each<[string, string, string]>([
    [
      'upper-case host',
      'https://HOOKS.Acme.TEST/in',
      'https://hooks.acme.test/in',
    ],
    [
      'default port written out',
      'https://hooks.acme.test:443/in',
      'https://hooks.acme.test/in',
    ],
    [
      'fragment',
      'https://hooks.acme.test/in#section',
      'https://hooks.acme.test/in',
    ],
    [
      'all three at once',
      'https://HOOKS.acme.test:443/in#x',
      'https://hooks.acme.test/in',
    ],
    [
      'query is kept',
      'https://hooks.acme.test/in?a=1&B=2',
      'https://hooks.acme.test/in?a=1&B=2',
    ],
    [
      'path case is kept',
      'https://hooks.acme.test/In/Case',
      'https://hooks.acme.test/In/Case',
    ],
    [
      'empty path becomes a slash',
      'https://hooks.acme.test',
      'https://hooks.acme.test/',
    ],
  ])('S43 AS-12: normalisation of %s', (_name, raw, expected) => {
    expect(normalizeEndpointUrl(raw)).toBe(expected);
    const parsed = parseEndpointUrl(raw);
    expect(parsed).toMatchObject({ ok: true, normalized: expected });
  });

  it('S43 AS-12: two spellings of one address have the same normal form, different addresses differ', () => {
    const a = normalizeEndpointUrl('https://Hooks.acme.test:443/in#a');
    const b = normalizeEndpointUrl('https://hooks.acme.test/in');
    const c = normalizeEndpointUrl('https://hooks.acme.test/other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('S43 AS-12: normalisation answers null for a value that does not parse', () => {
    expect(normalizeEndpointUrl('nonsense')).toBeNull();
  });

  describe('allowed receiver hosts (local profile, J02 G-32)', () => {
    const allowed = ['127.0.0.1:18443'];

    it('S43 G-32: a listed host:port may use its own port and an IP literal; the port stays in the normalised form', () => {
      expect(parseEndpointUrl('https://127.0.0.1:18443/hook', allowed)).toEqual(
        {
          ok: true,
          host: '127.0.0.1',
          normalized: 'https://127.0.0.1:18443/hook',
        },
      );
    });

    it('S43 G-32: an unlisted port or host keeps every rule', () => {
      expect(parseEndpointUrl('https://127.0.0.1:18444/hook', allowed)).toEqual(
        {
          ok: false,
          failure: { kind: 'rejected', reason: 'port_not_allowed' },
        },
      );
      expect(parseEndpointUrl('https://127.0.0.1/hook', allowed)).toEqual({
        ok: false,
        failure: { kind: 'rejected', reason: 'ip_literal' },
      });
      expect(parseEndpointUrl('https://127.0.0.1:18443/hook')).toEqual({
        ok: false,
        failure: { kind: 'rejected', reason: 'port_not_allowed' },
      });
    });

    it('S43 G-32: a listed host is https only and takes no credentials', () => {
      expect(parseEndpointUrl('http://127.0.0.1:18443/hook', allowed)).toEqual({
        ok: false,
        failure: { kind: 'rejected', reason: 'not_https' },
      });
      expect(
        parseEndpointUrl('https://user:pw@127.0.0.1:18443/hook', allowed),
      ).toEqual({
        ok: false,
        failure: { kind: 'rejected', reason: 'credentials_not_allowed' },
      });
    });
  });

  it('S43 AS-58: the parsed host carries no path, query or user-info', () => {
    const parsed = parseEndpointUrl(
      'https://hooks.acme.test/in?token=SECRET123',
    );
    expect(parsed).toMatchObject({ ok: true, host: 'hooks.acme.test' });
    expect(JSON.stringify(parsed.ok ? parsed.host : '')).not.toMatch(
      /token|SECRET123|\/in/,
    );
  });
});
