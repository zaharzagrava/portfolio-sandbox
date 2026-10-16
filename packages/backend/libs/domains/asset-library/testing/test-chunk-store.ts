import { Injectable } from '@nestjs/common';
import { Transform, type Readable } from 'node:stream';
import { StorageUnavailableError } from '../domain/ports';
import { ObjectChunkStore } from '../infra/chunk-store';

type Operation = 'exists' | 'open' | 'remove';

interface Fault {
  left: number;
  /** Calls that pass before the fault starts (fail the second chunk of a file, not the first). */
  skip: number;
  /** Only calls for this shop fail; other shops' calls (the shared database holds many) are untouched. */
  shopId: string | null;
}

/**
 * The real chunk store with the faults the specs need (test-plan: "a gate (latch) inside the storage adapter's
 * existence check", "a storage rule that fails or times out one call"). Real MinIO underneath; the fault is injected
 * where the production adapter would have raised `StorageUnavailableError` after its timeout.
 */
@Injectable()
export class TestChunkStore extends ObjectChunkStore {
  private failures = new Map<Operation, Fault>();
  private failAfterBytes: number | null = null;
  private gate: { entered: () => void; opened: Promise<void> } | null = null;
  /** Resolves when a call reached the gate. */
  waitingAtGate: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;

  /** The next `times` calls of `operation` (for `shopId`, when given) fail as if storage timed out. */
  failNext(
    operation: Operation,
    times = 1,
    shopId: string | null = null,
    skip = 0,
  ): void {
    this.failures.set(operation, { left: times, shopId, skip });
  }

  failAlways(operation: Operation, shopId: string | null = null): void {
    this.failures.set(operation, {
      left: Number.POSITIVE_INFINITY,
      shopId,
      skip: 0,
    });
  }

  /** Streams opened from now on fail after this many bytes (a mid-stream storage error). */
  failStreamAfter(bytes: number | null): void {
    this.failAfterBytes = bytes;
  }

  heal(): void {
    this.failures.clear();
    this.failAfterBytes = null;
  }

  /** The next `exists` call pauses until `openGate()`. */
  closeGate(): void {
    let entered!: () => void;
    this.waitingAtGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.gate = { entered, opened };
  }

  openGate(): void {
    this.release();
  }

  private maybeFail(operation: Operation, shopId: string): void {
    const fault = this.failures.get(operation);
    if (!fault || fault.left <= 0) return;
    if (fault.shopId !== null && fault.shopId !== shopId) return;
    if (fault.skip > 0) {
      fault.skip -= 1;
      return;
    }
    fault.left -= 1;
    throw new StorageUnavailableError(`${operation} (injected)`);
  }

  override async exists(shopId: string, hash: string): Promise<boolean> {
    const gate = this.gate;
    if (gate) {
      this.gate = null;
      gate.entered();
      await gate.opened;
    }
    this.maybeFail('exists', shopId);
    return super.exists(shopId, hash);
  }

  override async open(shopId: string, hash: string): Promise<Readable> {
    this.maybeFail('open', shopId);
    const stream = await super.open(shopId, hash);
    if (this.failAfterBytes === null) return stream;
    let seen = 0;
    const limit = this.failAfterBytes;
    const failing = new Transform({
      transform(piece: Buffer, _encoding, done) {
        seen += piece.length;
        if (seen > limit) done(new Error('injected stream failure'));
        else done(null, piece);
      },
    });
    stream.on('error', (error) => failing.destroy(error));
    return stream.pipe(failing);
  }

  override remove(shopId: string, hash: string): Promise<void> {
    this.maybeFail('remove', shopId);
    return super.remove(shopId, hash);
  }
}
