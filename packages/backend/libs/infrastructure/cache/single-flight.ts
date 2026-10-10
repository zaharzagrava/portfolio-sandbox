/**
 * Coalesces concurrent calls for the same key into one in-flight promise
 * (Go's singleflight). 1,000 requests for a cold product on one instance →
 * one loader call, not 1,000. A rejection is shared by every waiter and the
 * entry is removed when the promise settles, so the table is empty when idle.
 */
export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  size(): number {
    return this.inFlight.size;
  }
}
