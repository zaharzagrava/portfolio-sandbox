import { PassThrough, type Readable } from 'node:stream';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';

/**
 * Observes (and, on request, freezes or slows) the import's reads from object storage (S07 test-plan: "a gated storage
 * stream", "a recording wrapper on the storage port"). It wraps `getStream` of the real storage:
 *  - every call is recorded with the byte it asked to start from, the stream it got and how many bytes the reader took
 *    from it, so a spec can assert that a resume asked for a range, that a scan did not buffer the file, and that every
 *    stream ended `destroyed`;
 *  - `freezeAfter(bytes)` makes the next streams stop delivering once that many bytes passed, until `release()`: the
 *    worker is held right there (a chosen batch), without any sleep, and `reached` says when it stopped;
 *  - `trickle(bytes, ms)` makes the next streams deliver `bytes` every `ms` milliseconds (a slow but live source);
 *  - `failReads` makes `getStream` reject (a storage outage).
 * It observes and delays; it never changes what the storage holds.
 */
export interface RecordedRead {
  key: string;
  start: number;
  stream: Readable;
  /** Bytes the reader has taken from the stream so far. */
  delivered: () => number;
}

export class StorageProbe {
  readonly reads: RecordedRead[] = [];
  /** Resolves when a frozen stream has delivered its allowed bytes and stopped. */
  reached: Promise<void> = Promise.resolve();
  failReads: Error | null = null;
  private freezeBytes: number | null = null;
  private freezeOnce = false;
  private freezeSkip = 0;
  private trickling: { bytes: number; ms: number } | null = null;
  private gate: { open: () => void; wait: Promise<void> } | null = null;
  private reachedResolve: (() => void) | null = null;
  private original!: ObjectStorage['getStream'];
  private storage!: ObjectStorage;

  install(storage: ObjectStorage): void {
    this.storage = storage;
    this.original = storage.getStream.bind(storage);
    storage.getStream = async (key, options) => {
      if (this.failReads) throw this.failReads;
      const inner = await this.original(key, options);
      const start = options?.start ?? 0;
      let delivered = 0;
      let shaped: Readable;
      if (this.freezeBytes !== null && this.freezeSkip > 0) {
        this.freezeSkip -= 1; // not the stream the spec wants held (a scan and a sniff come before the rows)
        shaped = inner;
      } else if (this.freezeBytes !== null) {
        shaped = this.freeze(inner);
        // a once-freeze holds only one stream; the gate stays reachable for `release()`
        if (this.freezeOnce) this.freezeBytes = null;
      } else shaped = this.trickling ? this.slow(inner, this.trickling) : inner;
      // counts what the reader takes: the pass-through's small buffer keeps backpressure, so a stalled reader stalls the source
      const counted = new PassThrough({ highWaterMark: 16 * 1024 });
      const feed = shaped;
      feed.on('data', (chunk: Buffer) => {
        delivered += chunk.length;
        if (!counted.write(chunk)) {
          feed.pause();
          counted.once('drain', () => feed.resume());
        }
      });
      feed.once('end', () => counted.end());
      feed.once('error', (error) => counted.destroy(error));
      counted.once('close', () => {
        feed.destroy();
        inner.destroy();
      });
      this.reads.push({
        key,
        start,
        stream: counted,
        delivered: () => delivered,
      });
      return counted;
    };
  }

  uninstall(): void {
    if (this.storage) this.storage.getStream = this.original;
  }

  /** Reads of the import's source files (not report parts). */
  sources(): RecordedRead[] {
    return this.reads.filter((r) => r.key.endsWith('/source'));
  }

  /**
   * The next streams (with `once`, only the very next one) deliver `bytes` and then wait for `release()`. A second
   * call replaces the gate of the first, so release one before freezing again.
   */
  freezeAfter(
    bytes: number,
    options: { once?: boolean; skip?: number } = {},
  ): void {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    this.gate = { open, wait };
    this.freezeBytes = bytes;
    this.freezeOnce = options.once ?? false;
    this.freezeSkip = options.skip ?? 0;
    this.reached = new Promise<void>(
      (resolve) => (this.reachedResolve = resolve),
    );
  }

  /** The next streams deliver `bytes` bytes every `ms` milliseconds until `reset()`. */
  trickle(bytes: number, ms: number): void {
    this.trickling = { bytes, ms };
  }

  release(): void {
    this.freezeBytes = null;
    this.freezeOnce = false;
    this.gate?.open();
    this.gate = null;
  }

  reset(): void {
    this.release();
    this.trickling = null;
    this.reads.length = 0;
    this.failReads = null;
  }

  private freeze(inner: Readable): Readable {
    const limit = this.freezeBytes!;
    const gate = this.gate!;
    const out = new PassThrough();
    void (async () => {
      let sent = 0;
      let frozen = false;
      try {
        for await (const chunk of inner as AsyncIterable<Buffer>) {
          let piece = Buffer.from(chunk);
          while (piece.length > 0) {
            if (!frozen && sent >= limit) {
              frozen = true;
              this.reachedResolve?.();
              await gate.wait;
            }
            const room = frozen
              ? piece.length
              : Math.min(piece.length, limit - sent);
            const part = piece.subarray(0, room);
            piece = piece.subarray(room);
            sent += part.length;
            if (!out.write(part))
              await new Promise((r) => out.once('drain', r));
          }
        }
        out.end();
      } catch (error) {
        if (!out.destroyed) out.destroy(error as Error);
      }
    })();
    out.once('close', () => inner.destroy());
    return out;
  }

  private slow(
    inner: Readable,
    shape: { bytes: number; ms: number },
  ): Readable {
    const out = new PassThrough();
    void (async () => {
      try {
        for await (const chunk of inner as AsyncIterable<Buffer>) {
          let piece = Buffer.from(chunk);
          while (piece.length > 0 && !out.destroyed) {
            const part = piece.subarray(0, shape.bytes);
            piece = piece.subarray(part.length);
            await new Promise((r) => setTimeout(r, shape.ms));
            if (!out.write(part))
              await new Promise((r) => out.once('drain', r));
          }
        }
        out.end();
      } catch (error) {
        if (!out.destroyed) out.destroy(error as Error);
      }
    })();
    out.once('close', () => inner.destroy());
    return out;
  }
}
