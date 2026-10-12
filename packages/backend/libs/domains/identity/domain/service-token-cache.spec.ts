import { ServiceTokenCache } from './service-token-cache';

const T0 = new Date('2026-10-12T12:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

describe('Minted service token cache', () => {
  const mintCount = (cache: ServiceTokenCache, times: number[]) => {
    let minted = 0;
    return {
      tokens: times.map((sec) =>
        cache.get(
          { caller: 'worker', audience: 'core', ttlSec: 60 },
          at(sec),
          () => ({
            token: `token-${++minted}`,
          }),
        ),
      ),
      minted: () => minted,
    };
  };

  it('S01 AS-72: a token is reused until 80 % of its lifetime, then replaced', () => {
    const run = mintCount(new ServiceTokenCache(), [0, 47, 49]);

    expect(run.tokens).toEqual(['token-1', 'token-1', 'token-2']);
    expect(run.minted()).toBe(2);
  });

  it('S01 AS-72: the boundary is exclusive (48 s of 60 s mints again)', () => {
    expect(mintCount(new ServiceTokenCache(), [0, 48]).tokens).toEqual([
      'token-1',
      'token-2',
    ]);
  });

  it('S01 AS-72: different audiences, callers and lifetimes never share a token', () => {
    const cache = new ServiceTokenCache();
    let n = 0;
    const mint = () => ({ token: `t${++n}` });
    const a = cache.get(
      { caller: 'worker', audience: 'core', ttlSec: 60 },
      at(0),
      mint,
    );
    const b = cache.get(
      { caller: 'worker', audience: 'worker', ttlSec: 60 },
      at(0),
      mint,
    );
    const c = cache.get(
      { caller: 'billing', audience: 'core', ttlSec: 60 },
      at(0),
      mint,
    );
    const d = cache.get(
      { caller: 'worker', audience: 'core', ttlSec: 120 },
      at(0),
      mint,
    );

    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('S01 AS-72: a clock that moves backwards never serves a token from the future', () => {
    const cache = new ServiceTokenCache();
    let n = 0;
    const mint = () => ({ token: `t${++n}` });
    cache.get({ caller: 'w', audience: 'core', ttlSec: 60 }, at(100), mint);

    expect(
      cache.get({ caller: 'w', audience: 'core', ttlSec: 60 }, at(0), mint),
    ).toBe('t2');
  });
});
