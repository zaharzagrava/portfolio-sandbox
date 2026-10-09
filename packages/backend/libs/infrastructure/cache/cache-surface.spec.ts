import type { CacheService } from './cache.service';
import type { GetOrLoadOptions } from './cache-options';

type Surface = keyof CacheService;

describe('Cache service public surface', () => {
  it('S52 AS-40: no method stores a caller-supplied value; writers delete', () => {
    // Compile-time assertions: these fail `tsc` (and ts-jest) if a store method appears.
    expectNever<
      Extract<Surface, 'set' | 'put' | 'setex' | 'store' | 'write'>
    >();
    expectKeys<
      Surface,
      'getOrLoad' | 'getOrLoadMany' | 'invalidate' | 'invalidateIfOlder'
    >();

    const options: GetOrLoadOptions = { ttlMs: 1 };
    expect(options.ttlMs).toBe(1);
  });

  it('S52 AS-40: the service instance has no set/put member at run time', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CacheService: Impl } = require('./cache.service') as {
      CacheService: { prototype: Record<string, unknown> };
    };
    for (const name of ['set', 'put', 'setex', 'store', 'write'])
      expect(Impl.prototype[name]).toBeUndefined();
    for (const name of [
      'getOrLoad',
      'getOrLoadMany',
      'invalidate',
      'invalidateIfOlder',
    ])
      expect(typeof Impl.prototype[name]).toBe('function');
  });
});

/** Fails to compile when `T` is not `never`. */
function expectNever<T extends never>(): void {
  // type-level only
}
/** Fails to compile unless every name in `Expected` is a key of `Actual`. */
function expectKeys<Actual, Expected extends Actual>(): void {
  // type-level only
}
