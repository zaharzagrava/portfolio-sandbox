type AnyFn = (...args: never[]) => unknown;

export interface FaultSwitch {
  /** From now on the wrapped methods reject with `error` (a store outage). */
  down(error?: Error): void;
  /** The original behaviour again. */
  up(): void;
  readonly isDown: boolean;
  /** Puts every method back; the switch must not be used afterwards. */
  restore(): void;
}

/**
 * A switchable outage for a real collaborator (the cap store, the rate-limit store, the realtime hub, a queue): the
 * named methods of `target` are wrapped in place and reject while the switch is `down()`. The collaborator stays the
 * production instance underneath, so `up()` restores the real behaviour with real state. Used for the Gate 9 fault
 * tests (cap store unavailable, limiter outage, hub down).
 */
export function faultSwitch<T extends object>(
  target: T,
  methods: ReadonlyArray<keyof T>,
): FaultSwitch {
  let failure: Error | null = null;
  const originals = new Map<keyof T, T[keyof T]>();
  for (const name of methods) {
    const original = target[name];
    if (typeof original !== 'function')
      throw new Error(`faultSwitch: ${String(name)} is not a method`);
    originals.set(name, original);
    (target as Record<keyof T, unknown>)[name] = (...args: unknown[]) =>
      failure
        ? Promise.reject(failure)
        : (original as unknown as AnyFn).apply(target, args as never[]);
  }
  return {
    down: (error = new Error('store unavailable (fault switch)')) => {
      failure = error;
    },
    up: () => {
      failure = null;
    },
    get isDown() {
      return failure !== null;
    },
    restore: () => {
      for (const [name, original] of originals)
        (target as Record<keyof T, unknown>)[name] = original;
      failure = null;
    },
  };
}
