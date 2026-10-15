import { randomUUID } from 'node:crypto';
import { FakeClock } from '@app/common/core/clock';
import {
  CacheInstance,
  createCacheInstance,
  ScriptedRandom,
  uniqueNamespace,
} from './testing/cache-fixture.module';

const keyIn = (ns: string) => `${ns}:v1:${randomUUID()}`;

describe('Cache peek (read without loading)', () => {
  const clock = new FakeClock();
  let a: CacheInstance;

  beforeAll(async () => {
    a = await createCacheInstance({
      clock,
      random: ScriptedRandom.constant(0.5),
    });
  });
  afterAll(async () => {
    await a.close();
  });

  it('S52 peek: an absent key is null and the loader is not involved', async () => {
    expect(await a.cache.peek(keyIn(uniqueNamespace()))).toBeNull();
  });

  it('S52 peek: a stored entry is returned with its version and freshness, and peeking never loads or refreshes it', async () => {
    const key = keyIn(uniqueNamespace());
    const options = {
      ttlMs: 60_000,
      jitter: 0,
      staleIfErrorMs: 600_000,
      versionOf: (v: { n: number }) => v.n,
    };
    await a.cache.getOrLoad(key, async () => ({ n: 7 }), options);

    expect(await a.cache.peek<{ n: number }>(key)).toEqual({
      value: { n: 7 },
      fresh: true,
      version: 7,
    });

    clock.advance(61_000);
    expect(await a.cache.peek<{ n: number }>(key)).toEqual({
      value: { n: 7 },
      fresh: false,
      version: 7,
    });

    // past the hard limit (ttl + staleIfError) nothing usable remains
    clock.advance(600_000);
    expect(await a.cache.peek(key)).toBeNull();
  });

  it('S52 peek: an invalid key is refused', async () => {
    await expect(a.cache.peek('no-namespace')).rejects.toThrow();
  });
});
