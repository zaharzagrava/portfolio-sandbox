import { randomBytes } from 'node:crypto';
import { parseBffSettings } from '@app/common/config/bff-config';

const key = () => randomBytes(32).toString('base64');

const valid = () => ({
  bff_upstream_url: 'https://api.internal.example',
  bff_session_keys: key(),
  bff_csrf_key: key(),
  bff_allowed_origins: 'https://shop.example',
});

const parse = (over: Record<string, unknown> = {}, production = false) =>
  parseBffSettings({ ...valid(), ...over }, { production });

describe('S48 BFF configuration (startup validation)', () => {
  it('S48 AS-63: a complete configuration yields the spec defaults', () => {
    const s = parse();
    expect(s.upstreamOrigin).toBe('https://api.internal.example');
    expect(s.allowedOrigins).toEqual(['https://shop.example']);
    expect(s.budgetsMs).toEqual({
      product: 800,
      shop: 300,
      recommendations: 300,
      trending: 200,
      flags: 150,
      chatUnread: 200,
      discussions: 300,
      videos: 300,
      pickup: 300,
      flashSale: 200,
      auction: 200,
    });
    expect(s.pageDeadlineMs).toBe(1_000);
    expect(s.graphql).toMatchObject({
      deadlineMs: 2_000,
      maxDepth: 6,
      maxCost: 2_000,
      maxRootFields: 20,
      maxDocumentBytes: 8 * 1024,
      maxIds: 50,
      batchSize: 100,
      shopBudgetMs: 500,
    });
    expect(s.breaker).toEqual({
      failures: 5,
      windowMs: 10_000,
      openMs: 10_000,
    });
    expect(s.gate).toEqual({ perUpstream: 100, perRequest: 12 });
    expect(s.cacheCeilingMs).toBe(30_000);
    expect(s.session).toMatchObject({
      idleMs: 24 * 3_600_000,
      absoluteMs: 30 * 86_400_000,
      mfaPendingMs: 300_000,
      refreshSkewMs: 30_000,
      refreshWaitMs: 3_000,
    });
    expect(s.sessionKeys).toHaveLength(1);
    expect(s.localDev).toBe(false);
    expect(s.trustedDocuments).toBe(true);
  });

  it.each([
    ['missing upstream url', { bff_upstream_url: undefined }, false],
    ['empty upstream url', { bff_upstream_url: '' }, false],
    ['malformed upstream url', { bff_upstream_url: 'not a url' }, false],
    [
      'plain http to a remote host',
      { bff_upstream_url: 'http://api.internal.example' },
      false,
    ],
    [
      'plain http in production even to loopback',
      { bff_upstream_url: 'http://127.0.0.1:9000' },
      true,
    ],
    ['url with a path', { bff_upstream_url: 'https://a.example/api' }, false],
    ['missing session keys', { bff_session_keys: undefined }, false],
    ['session key too short', { bff_session_keys: 'AAAA' }, false],
    [
      'three session keys',
      { bff_session_keys: [key(), key(), key()].join(',') },
      false,
    ],
    [
      'duplicate session keys',
      (() => {
        const k = key();
        return { bff_session_keys: `${k},${k}` };
      })(),
      false,
    ],
    ['missing csrf key', { bff_csrf_key: undefined }, false],
    ['short csrf key', { bff_csrf_key: 'AAAA' }, false],
    ['empty allowed origins', { bff_allowed_origins: '' }, false],
    [
      'allowed origin with a path',
      { bff_allowed_origins: 'https://shop.example/x' },
      false,
    ],
    [
      'plain http allowed origin in production',
      { bff_allowed_origins: 'http://shop.example' },
      true,
    ],
    [
      'trusted documents off in production',
      { bff_trusted_documents: false },
      true,
    ],
  ])('S48 AS-63: %s stops startup', (_name, over, production) => {
    expect(() => parse(over, production)).toThrow(/bff_/);
  });

  it('S48 AS-63: the error names the key and never prints the value', () => {
    const secret = 'super-secret-value-that-is-not-base64!!';
    try {
      parse({ bff_csrf_key: secret });
      fail('expected a throw');
    } catch (e) {
      expect(String((e as Error).message)).toContain('bff_csrf_key');
      expect(String((e as Error).message)).not.toContain(secret);
    }
  });

  it('S48 AS-37: trusted documents are on by default and cannot be switched off in production without local dev', () => {
    expect(parse({}, true).trustedDocuments).toBe(true);
    expect(
      parse({ bff_trusted_documents: false }, false).trustedDocuments,
    ).toBe(false);
    expect(
      parse({ bff_trusted_documents: false, bff_local_dev: true }, true)
        .trustedDocuments,
    ).toBe(false);
  });

  it('S48 AS-37: local dev turns trusted-document enforcement off by default', () => {
    expect(parse({ bff_local_dev: true }).trustedDocuments).toBe(false);
  });

  it('S48 AS-40: introspection is off in production and on elsewhere unless configured', () => {
    expect(parse({}, false).introspection).toBe(true);
    expect(parse({}, true).introspection).toBe(false);
    expect(parse({ bff_introspection: false }, false).introspection).toBe(
      false,
    );
    expect(parse({ bff_introspection: true }, true).introspection).toBe(true);
  });

  it('S48 AS-63: http to a loopback upstream is accepted outside production', () => {
    expect(
      parse({ bff_upstream_url: 'http://127.0.0.1:9000' }).upstreamOrigin,
    ).toBe('http://127.0.0.1:9000');
  });

  it('S48 AS-43: two session keys form a ring, newest first', () => {
    const a = key();
    const b = key();
    const s = parse({ bff_session_keys: `${a},${b}` });
    expect(s.sessionKeys.map((k) => k.toString('base64'))).toEqual([a, b]);
  });

  it('S48 FR-051: numeric overrides are honoured and out-of-range values stop startup', () => {
    expect(parse({ bff_page_deadline_ms: 1_500 }).pageDeadlineMs).toBe(1_500);
    expect(() => parse({ bff_page_deadline_ms: 0 })).toThrow(
      /bff_page_deadline_ms/,
    );
    expect(() => parse({ bff_graphql_max_depth: 1_000 })).toThrow(
      /bff_graphql_max_depth/,
    );
  });
});
