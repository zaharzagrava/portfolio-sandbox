import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { closeNestContexts, nestContext } from './nest-context';

/** The cached application context of a Nest-based function, with fixture modules (no database). */
describe('nestContext (e2e)', () => {
  afterEach(() => closeNestContexts());

  function counterModule() {
    const state = { inits: 0 };
    @Injectable()
    class Counter implements OnModuleInit {
      onModuleInit() {
        state.inits++;
      }
    }
    @Module({ providers: [Counter], exports: [Counter] })
    class CounterModule {}
    return { CounterModule, Counter, state };
  }

  it('S55 AS-46: three invocations, two of them concurrent, initialise the module once and share one context', async () => {
    const { CounterModule, Counter, state } = counterModule();
    const [a, b] = await Promise.all([
      nestContext(CounterModule),
      nestContext(CounterModule),
    ]);
    const c = await nestContext(CounterModule);
    expect(state.inits).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c.get(Counter)).toBeInstanceOf(Counter);
  });

  it('S55 AS-30: the manifest dbPoolMax becomes the pool size of the context', async () => {
    const { CounterModule } = counterModule();
    const before = process.env.DB_POOL_MAX;
    try {
      await nestContext(CounterModule, { dbPoolMax: 2 });
      expect(process.env.DB_POOL_MAX).toBe('2');
    } finally {
      if (before === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = before;
    }
  });

  it('S55 AS-47: a failed initialisation is not cached, the next invocation initialises again, another module is unaffected', async () => {
    const other = counterModule();
    const otherContext = await nestContext(other.CounterModule);

    let attempts = 0;
    @Injectable()
    class Flaky implements OnModuleInit {
      onModuleInit() {
        if (++attempts === 1) throw new Error('database not reachable yet');
      }
    }
    @Module({ providers: [Flaky] })
    class FlakyModule {}

    await expect(nestContext(FlakyModule)).rejects.toThrow(
      'database not reachable yet',
    );
    const second = await nestContext(FlakyModule);
    expect(attempts).toBe(2);
    expect(second.get(Flaky)).toBeInstanceOf(Flaky);
    expect(await nestContext(other.CounterModule)).toBe(otherContext);
    expect(other.state.inits).toBe(1);
  });
});
