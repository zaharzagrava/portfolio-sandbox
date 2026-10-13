import { createVerify, generateKeyPairSync } from 'node:crypto';
import { FakeClock } from '@app/common/core/clock';
import {
  CREDENTIAL_TTL_MS,
  credentialExpiresAt,
  DeliveryEdge,
  DeliveryEdgeNotConfiguredError,
} from './delivery-edge.port';
import { CloudFrontDeliveryEdge } from './cloudfront-delivery-edge';
import { InMemoryDeliveryEdge } from './in-memory-delivery-edge';
import { UnconfiguredDeliveryEdge } from './unconfigured-delivery-edge';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEY_PAIR_ID = 'KTESTPAIR123';
const PATTERN = 'https://stream.example.test/u/6f1c0e9a-video/*';

/** CloudFront's URL-safe base64: '+' -> '-', '=' -> '_', '/' -> '~'. */
const fromCloudFrontBase64 = (value: string): Buffer =>
  Buffer.from(
    value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'),
    'base64',
  );

const clock = new FakeClock(new Date('2026-03-01T10:00:00.000Z'));

describe('S30 AS-35 / AS-58: delivery edge port', () => {
  const adapters: [string, () => DeliveryEdge][] = [
    [
      'CloudFront',
      () =>
        new CloudFrontDeliveryEdge({
          keyPairId: KEY_PAIR_ID,
          privateKey,
          invalidate: async () => undefined,
        }),
    ],
    [
      'in-memory',
      () => new InMemoryDeliveryEdge({ keyPairId: KEY_PAIR_ID, privateKey }),
    ],
  ];

  describe.each(adapters)('%s adapter', (_name, make) => {
    it('S30 AS-35: signs the three cookies; the signature verifies against the public key', async () => {
      const expiresAt = credentialExpiresAt(clock);
      const cookies = await make().signCookies({
        resourcePattern: PATTERN,
        expiresAt,
      });

      expect(Object.keys(cookies).sort()).toEqual([
        'CloudFront-Key-Pair-Id',
        'CloudFront-Policy',
        'CloudFront-Signature',
      ]);
      expect(cookies['CloudFront-Key-Pair-Id']).toBe(KEY_PAIR_ID);
      const policy = fromCloudFrontBase64(cookies['CloudFront-Policy']);
      const verifier = createVerify('RSA-SHA1');
      verifier.update(policy);
      expect(
        verifier.verify(
          publicKey,
          fromCloudFrontBase64(cookies['CloudFront-Signature']),
        ),
      ).toBe(true);
    });

    it('S30 AS-35: the policy holds exactly one resource pattern (one video) and one expiry', async () => {
      const expiresAt = credentialExpiresAt(clock);
      const cookies = await make().signCookies({
        resourcePattern: PATTERN,
        expiresAt,
      });
      const policy = JSON.parse(
        fromCloudFrontBase64(cookies['CloudFront-Policy']).toString(),
      ) as {
        Statement: {
          Resource: string;
          Condition: Record<string, Record<string, number>>;
        }[];
      };

      expect(policy.Statement).toHaveLength(1);
      expect(policy.Statement[0].Resource).toBe(PATTERN);
      expect(Object.keys(policy.Statement[0].Condition)).toEqual([
        'DateLessThan',
      ]);
      expect(policy.Statement[0].Condition.DateLessThan).toEqual({
        'AWS:EpochTime': Math.floor(expiresAt.getTime() / 1000),
      });
    });

    it('S30 AS-35: a tampered policy fails verification', async () => {
      const cookies = await make().signCookies({
        resourcePattern: PATTERN,
        expiresAt: credentialExpiresAt(clock),
      });
      const other = await make().signCookies({
        resourcePattern: 'https://stream.example.test/u/other-video/*',
        expiresAt: credentialExpiresAt(clock),
      });
      const verifier = createVerify('RSA-SHA1');
      verifier.update(fromCloudFrontBase64(other['CloudFront-Policy']));
      expect(
        verifier.verify(
          publicKey,
          fromCloudFrontBase64(cookies['CloudFront-Signature']),
        ),
      ).toBe(false);
    });

    it('S30 AS-35: refuses a pattern that is not a single video path', async () => {
      await expect(
        make().signCookies({
          resourcePattern: '*',
          expiresAt: credentialExpiresAt(clock),
        }),
      ).rejects.toThrow(/resourcePattern/);
    });
  });

  it('S30 AS-35: the credential lives 4 hours from the injected clock, never from the system time', () => {
    expect(CREDENTIAL_TTL_MS).toBe(4 * 3600 * 1000);
    const fake = new FakeClock(new Date('2031-06-01T00:00:00.000Z'));
    expect(credentialExpiresAt(fake).toISOString()).toBe(
      '2031-06-01T04:00:00.000Z',
    );
    fake.advance(60_000);
    expect(credentialExpiresAt(fake).toISOString()).toBe(
      '2031-06-01T04:01:00.000Z',
    );
  });

  it('S30 AS-35: the in-memory edge records the cookies it signed and does not read the system time', async () => {
    const edge = new InMemoryDeliveryEdge({
      keyPairId: KEY_PAIR_ID,
      privateKey,
    });
    const spy = jest.spyOn(Date, 'now');
    await edge.signCookies({
      resourcePattern: PATTERN,
      expiresAt: credentialExpiresAt(clock),
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(edge.signed.map((s) => s.resourcePattern)).toEqual([PATTERN]);
  });

  it('S30 AS-35: a missing key is a typed error, never an unsigned URL or cookie', async () => {
    const unconfigured: DeliveryEdge = new UnconfiguredDeliveryEdge();
    await expect(
      unconfigured.signCookies({
        resourcePattern: PATTERN,
        expiresAt: credentialExpiresAt(clock),
      }),
    ).rejects.toBeInstanceOf(DeliveryEdgeNotConfiguredError);
    await expect(unconfigured.invalidate(['/u/x/*'])).rejects.toBeInstanceOf(
      DeliveryEdgeNotConfiguredError,
    );
    for (const missing of [
      { keyPairId: '', privateKey },
      { keyPairId: KEY_PAIR_ID, privateKey: '' },
    ]) {
      await expect(
        new CloudFrontDeliveryEdge({
          ...missing,
          invalidate: async () => undefined,
        }).signCookies({
          resourcePattern: PATTERN,
          expiresAt: credentialExpiresAt(clock),
        }),
      ).rejects.toBeInstanceOf(DeliveryEdgeNotConfiguredError);
      await expect(
        new InMemoryDeliveryEdge(missing).signCookies({
          resourcePattern: PATTERN,
          expiresAt: credentialExpiresAt(clock),
        }),
      ).rejects.toBeInstanceOf(DeliveryEdgeNotConfiguredError);
    }
  });

  it('S30 AS-40: a path-removal request is recorded by the in-memory edge', async () => {
    const edge = new InMemoryDeliveryEdge({
      keyPairId: KEY_PAIR_ID,
      privateKey,
    });
    await edge.invalidate(['/p/abc/*', '/u/abc/*']);
    await edge.invalidate(['/p/def/*']);
    expect(edge.invalidations).toEqual([
      ['/p/abc/*', '/u/abc/*'],
      ['/p/def/*'],
    ]);
  });

  it('S30 AS-40: a path-removal request can be made to fail, and is not recorded as done', async () => {
    const edge = new InMemoryDeliveryEdge({
      keyPairId: KEY_PAIR_ID,
      privateKey,
    });
    edge.failInvalidations(new Error('edge unavailable'));
    await expect(edge.invalidate(['/p/abc/*'])).rejects.toThrow(
      'edge unavailable',
    );
    expect(edge.invalidations).toEqual([]);
    edge.failInvalidations(undefined);
    await edge.invalidate(['/p/abc/*']);
    expect(edge.invalidations).toEqual([['/p/abc/*']]);
  });

  it('S30 AS-40: the CloudFront adapter hands the paths to the injected invalidation function; an empty list is a no-op', async () => {
    const calls: string[][] = [];
    const edge = new CloudFrontDeliveryEdge({
      keyPairId: KEY_PAIR_ID,
      privateKey,
      invalidate: async (paths) => {
        calls.push(paths);
      },
    });
    await edge.invalidate([]);
    await edge.invalidate(['/u/abc/*']);
    expect(calls).toEqual([['/u/abc/*']]);
  });
});
