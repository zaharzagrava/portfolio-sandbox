import {
  generateApiKey,
  generateUniqueApiKey,
  hashSecret,
  hashSecretWithVersion,
  parseApiKey,
  secretMatches,
  verifySecret,
} from './api-key-format';

/** Key minting/verification is shared by the dashboard, the public API and the worker. */
describe('API key format', () => {
  it('round-trips and encodes the mode in the prefix (secret scanners match sk_live_)', () => {
    const live = generateApiKey(true);
    expect(live.key).toMatch(/^sk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);
    expect(parseApiKey(live.key)).toEqual({
      livemode: true,
      prefix: live.prefix,
      secret: live.secret,
    });
    expect(parseApiKey(generateApiKey(false).key)?.livemode).toBe(false);
    expect(parseApiKey('sk_live_short_bad')).toBeNull();
  });

  it('verifies against the peppered hash only', () => {
    const { secret } = generateApiKey(true);
    const stored = hashSecret(secret, 'pepper');
    expect(secretMatches(secret, stored, 'pepper')).toBe(true);
    expect(secretMatches(secret, stored, 'other-pepper')).toBe(false);
    // a different last character: a fixed 'x' equals the original one time in 62
    const last = secret.endsWith('x') ? 'y' : 'x';
    expect(
      secretMatches(`${secret.slice(0, -1)}${last}`, stored, 'pepper'),
    ).toBe(false);
  });

  it('S42 AS-20: parse refuses keys with extra or missing parts', () => {
    const { key } = generateApiKey(false);
    expect(parseApiKey(`${key}x`)).toBeNull();
    expect(parseApiKey(key.slice(1))).toBeNull();
    expect(parseApiKey(`${key}\n`)).toBeNull();
    expect(parseApiKey('')).toBeNull();
  });

  it('S42 AS-20: regenerates on a prefix collision, at most 5 times', async () => {
    const taken = new Set<string>();
    let calls = 0;
    const exists = async (prefix: string) => {
      calls += 1;
      if (calls <= 2) {
        taken.add(prefix);
        return true;
      }
      return false;
    };
    const minted = await generateUniqueApiKey(true, exists);
    expect(calls).toBe(3);
    expect(taken.has(minted.prefix)).toBe(false);

    await expect(generateUniqueApiKey(true, async () => true)).rejects.toThrow(
      /prefix/,
    );
  });

  it('S42 AS-21: verifies with the current pepper (version 1) and the previous one (version 0)', () => {
    const { secret } = generateApiKey(true);
    const peppers = { current: 'new', previous: 'old' };
    const v1 = hashSecretWithVersion(secret, peppers, 1);
    const v0 = hashSecretWithVersion(secret, peppers, 0);
    expect(verifySecret(secret, v1, 1, peppers)).toEqual({
      ok: true,
      rehash: false,
    });
    expect(verifySecret(secret, v0, 0, peppers)).toEqual({
      ok: true,
      rehash: true,
    });
    expect(verifySecret('x'.repeat(32), v1, 1, peppers)).toEqual({
      ok: false,
      rehash: false,
    });
    // no previous pepper configured: version 0 rows cannot verify
    expect(verifySecret(secret, v0, 0, { current: 'new' })).toEqual({
      ok: false,
      rehash: false,
    });
  });

  it('S42 AS-21: rows written before a rotation (still labelled 1) verify with the previous pepper and ask for a re-hash', () => {
    const { secret } = generateApiKey(true);
    const stored = hashSecret(secret, 'old');
    expect(
      verifySecret(secret, stored, 1, { current: 'new', previous: 'old' }),
    ).toEqual({
      ok: true,
      rehash: true,
    });
    expect(verifySecret(secret, stored, 1, { current: 'new' })).toEqual({
      ok: false,
      rehash: false,
    });
    expect(
      verifySecret('y'.repeat(32), stored, 1, {
        current: 'new',
        previous: 'old',
      }),
    ).toEqual({
      ok: false,
      rehash: false,
    });
  });

  it('S42 AS-20: 10,000 generated secrets use the 62 symbols uniformly (no modulo bias)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i += 1)
      for (const c of generateApiKey(true).secret)
        counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(62);
    const expected = (10_000 * 32) / 62;
    // Per-symbol sd is ~1.4% of the mean; 8% is ~5.7 sigma (a 5% bound over 62
    // symbols failed ~3% of runs by chance). Modulo bias skews 8 symbols by 25%.
    for (const n of counts.values())
      expect(Math.abs(n - expected) / expected).toBeLessThan(0.08);
  });
});
