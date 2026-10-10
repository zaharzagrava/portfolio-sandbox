interface Flight {
  promise: Promise<unknown>;
  waiters: number;
  controller: AbortController;
  settled: boolean;
}

const abortError = () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
};

/**
 * In-process request coalescing (S48 FR-011, AS-20): identical concurrent calls share one upstream call. The shared
 * call is cancelled only when every caller waiting for it has gone, so one impatient request cannot cancel the answer
 * 49 others still wait for.
 */
export class SingleFlight {
  private readonly flights = new Map<string, Flight>();

  /** Number of distinct calls currently in flight. */
  get size(): number {
    return this.flights.size;
  }

  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    start: (flightSignal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T; coalesced: boolean }> {
    let flight = this.flights.get(key);
    const coalesced = flight !== undefined;
    if (!flight) {
      const controller = new AbortController();
      const created: Flight = {
        promise: Promise.resolve(),
        waiters: 0,
        controller,
        settled: false,
      };
      created.promise = start(controller.signal).finally(() => {
        created.settled = true;
        if (this.flights.get(key) === created) this.flights.delete(key);
      });
      // a rejection nobody waits for any more must not become an unhandled rejection
      created.promise.catch(() => undefined);
      this.flights.set(key, created);
      flight = created;
    }
    const joined = flight;
    joined.waiters++;
    return new Promise((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        joined.waiters--;
        if (joined.waiters === 0 && !joined.settled) {
          if (this.flights.get(key) === joined) this.flights.delete(key);
          joined.controller.abort();
        }
      };
      const onAbort = () => {
        if (done) return;
        leave();
        reject(abortError());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      joined.promise.then(
        (value) => {
          if (done) return;
          leave();
          resolve({ value: value as T, coalesced });
        },
        (error: unknown) => {
          if (done) return;
          leave();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
