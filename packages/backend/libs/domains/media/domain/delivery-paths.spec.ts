import {
  deliveryPrefix,
  deliveryUrl,
  masterKey,
  posterKey,
  renditionPlaylistKey,
  renditionPrefix,
  sourceKey,
  SOURCE_PREFIX,
  PUBLIC_PREFIX,
  UNLISTED_PREFIX,
  spritePrefix,
  spriteKey,
  spriteVttKey,
  unlistedCookiePath,
  unlistedResourcePattern,
  videoKeyPrefixes,
  posterPrefix,
} from './delivery-paths';

const ID = '3f1f6b64-5a6e-4d3c-9c0f-0a1b2c3d4e5f';
const OTHER = '9a8b7c6d-1111-4222-8333-444455556666';

describe('delivery path builders', () => {
  it('S30 AS-36: the three prefixes are pairwise disjoint (none is a prefix of another)', () => {
    const prefixes = [SOURCE_PREFIX, PUBLIC_PREFIX, UNLISTED_PREFIX];
    expect(new Set(prefixes).size).toBe(3);
    for (const a of prefixes)
      for (const b of prefixes)
        if (a !== b) expect(a.startsWith(b)).toBe(false);
    expect([SOURCE_PREFIX, PUBLIC_PREFIX, UNLISTED_PREFIX]).toEqual([
      'vsrc/',
      'p/',
      'u/',
    ]);
  });

  it('S30 AS-36: the source key sits under vsrc/ and no delivery prefix covers it', () => {
    expect(sourceKey(ID)).toBe(`vsrc/${ID}/source`);
    for (const vis of ['public', 'unlisted'] as const) {
      expect(sourceKey(ID).startsWith(deliveryPrefix(vis, ID))).toBe(false);
      expect(
        sourceKey(ID).startsWith(`${deliveryPrefix(vis, ID).slice(0, 2)}`),
      ).toBe(false);
    }
  });

  it.each([
    ['public', `p/${ID}/`],
    ['unlisted', `u/${ID}/`],
  ] as const)('S30 AS-31: %s outputs live under %s', (vis, prefix) => {
    expect(deliveryPrefix(vis, ID)).toBe(prefix);
    expect(masterKey(vis, ID)).toBe(`${prefix}master.m3u8`);
  });

  it('S30 AS-26: the output locations of two attempts of one rendition differ', () => {
    const a1 = renditionPrefix('public', ID, 720, 1);
    const a2 = renditionPrefix('public', ID, 720, 2);
    expect(a1).toBe(`p/${ID}/r/720/a1/`);
    expect(a2).toBe(`p/${ID}/r/720/a2/`);
    expect(a1).not.toBe(a2);
    expect(a1.startsWith(a2)).toBe(false);
    expect(a2.startsWith(a1)).toBe(false);
    expect(renditionPlaylistKey('public', ID, 720, 2)).toBe(`${a2}index.m3u8`);
  });

  it.each([
    ['poster', posterKey, posterPrefix, 'poster.jpg'],
    ['sprite', spriteKey, spritePrefix, 'sprite.jpg'],
    ['sprite track', spriteVttKey, spritePrefix, 'sprite.vtt'],
  ] as const)(
    'S30 AS-26: %s keys are per attempt and under the attempt prefix',
    (_n, key, prefix, file) => {
      expect(key('unlisted', ID, 1)).not.toBe(key('unlisted', ID, 2));
      expect(key('unlisted', ID, 2)).toBe(
        `${prefix('unlisted', ID, 2)}${file}`,
      );
      expect(prefix('unlisted', ID, 2).startsWith(`u/${ID}/`)).toBe(true);
    },
  );

  it.each([
    [240, 1],
    [480, 2],
    [720, 3],
    [1080, 1],
  ])(
    'S30 AS-26: rendition %i attempt %i differs from every other combination',
    (rung, attempt) => {
      const key = renditionPrefix('public', ID, rung, attempt);
      for (const r of [240, 480, 720, 1080])
        for (const a of [1, 2, 3])
          if (r !== rung || a !== attempt)
            expect(renditionPrefix('public', ID, r, a)).not.toBe(key);
    },
  );

  it('S30 AS-26: different videos never share a key', () => {
    expect(masterKey('public', ID)).not.toBe(masterKey('public', OTHER));
    expect(sourceKey(ID)).not.toBe(sourceKey(OTHER));
  });

  describe('no client string reaches a key', () => {
    const evil = [
      '../../etc/passwd',
      'x/../y',
      `${ID}/../${OTHER}`,
      `${ID}/`,
      'my video.mp4',
      '',
      '%2e%2e',
      "id'; drop table",
    ];

    it.each(evil)(
      'S30 AS-36: video id %j is refused by every builder',
      (bad) => {
        expect(() => sourceKey(bad)).toThrow();
        expect(() => deliveryPrefix('public', bad)).toThrow();
        expect(() => masterKey('unlisted', bad)).toThrow();
        expect(() => renditionPrefix('public', bad, 720, 1)).toThrow();
        expect(() => posterKey('public', bad, 1)).toThrow();
        expect(() => unlistedCookiePath(bad)).toThrow();
        expect(() => videoKeyPrefixes(bad)).toThrow();
      },
    );

    it.each([0, -1, 1.5, Number.NaN, 4.0000001])(
      'S30 AS-26: attempt %f is refused',
      (attempt) => {
        expect(() => renditionPrefix('public', ID, 720, attempt)).toThrow();
        expect(() => posterKey('public', ID, attempt)).toThrow();
      },
    );

    it.each([0, 100, 239, -240, 1.5, Number.NaN])(
      'S30 AS-26: rung %f is not a ladder rung',
      (rung) => {
        expect(() => renditionPrefix('public', ID, rung, 1)).toThrow();
      },
    );

    it('S30 AS-36: an unknown visibility is refused', () => {
      expect(() => deliveryPrefix('private' as never, ID)).toThrow();
    });

    it('S30 AS-36: upper-case uuids are refused (one spelling per id)', () => {
      expect(() => sourceKey(ID.toUpperCase())).toThrow();
    });
  });

  describe('credential scope and URLs', () => {
    it('S30 AS-32: the unlisted cookie path and resource pattern cover exactly one video', () => {
      expect(unlistedCookiePath(ID)).toBe(`/u/${ID}/`);
      expect(unlistedResourcePattern('https://stream.example.test', ID)).toBe(
        `https://stream.example.test/u/${ID}/*`,
      );
      expect(unlistedResourcePattern('https://stream.example.test/', ID)).toBe(
        `https://stream.example.test/u/${ID}/*`,
      );
    });

    it('S30 AS-31: deliveryUrl joins the CDN base and a key without double slashes', () => {
      expect(
        deliveryUrl('https://stream.example.test', `p/${ID}/master.m3u8`),
      ).toBe(`https://stream.example.test/p/${ID}/master.m3u8`);
      expect(
        deliveryUrl('https://stream.example.test/', `p/${ID}/master.m3u8`),
      ).toBe(`https://stream.example.test/p/${ID}/master.m3u8`);
    });

    it('S30 AS-36: deliveryUrl refuses the source prefix', () => {
      expect(() =>
        deliveryUrl('https://stream.example.test', sourceKey(ID)),
      ).toThrow();
      expect(() => deliveryUrl('https://stream.example.test', 'x/y')).toThrow();
    });

    it('S30 AS-52: purge covers the source and both delivery prefixes of one video', () => {
      expect(videoKeyPrefixes(ID)).toEqual([
        `vsrc/${ID}/`,
        `p/${ID}/`,
        `u/${ID}/`,
      ]);
    });
  });
});
