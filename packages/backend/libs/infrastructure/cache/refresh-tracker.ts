/**
 * Background refreshes (SWR, XFetch): at most one per key per process, tracked so shutdown can await them
 * (FR-044). Empty when idle.
 */
export class RefreshTracker {
  private readonly pending = new Map<string, Promise<void>>();

  /** Starts `fn` unless a refresh of `key` is already running; `fn` must not reject. */
  track(key: string, fn: () => Promise<void>): boolean {
    if (this.pending.has(key)) return false;
    const promise = fn().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return true;
  }

  size(): number {
    return this.pending.size;
  }

  /** Waits for the running refreshes for at most `timeoutMs`, then gives up without error. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([
        Promise.allSettled([...this.pending.values()]),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
