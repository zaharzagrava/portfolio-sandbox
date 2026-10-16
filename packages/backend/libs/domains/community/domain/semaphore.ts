/** Counting semaphore: at most `size` calls of `run` are inside at once; the rest wait in arrival order. */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly size: number) {
    this.free = size;
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await call();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}
