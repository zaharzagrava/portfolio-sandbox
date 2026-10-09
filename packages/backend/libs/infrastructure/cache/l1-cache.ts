import { LRUCache } from 'lru-cache';
import { Clock } from '@app/common/core/clock';
import { Envelope, parseEnvelope } from './entry-codec';

interface L1Entry {
  /** The serialized envelope: a hit parses a fresh copy, so callers can never mutate what other callers read. */
  payload: string;
  exp: number;
  ver?: number;
  /** L1 lifetime end (injected clock). */
  until: number;
}

/**
 * The in-process level: an LRU bounded by entry count and serialized bytes (FR-003), with a per-entry lifetime
 * on the injected clock (FR-002). Only fresh entries are held; the owner decides whether L1 may be used at all.
 */
export class L1Cache {
  private readonly lru: LRUCache<string, L1Entry>;

  constructor(
    maxEntries: number,
    maxBytes: number,
    private readonly clock: Clock,
  ) {
    this.lru = new LRUCache<string, L1Entry>({
      max: maxEntries,
      maxSize: maxBytes,
      sizeCalculation: (entry) => Math.max(1, Buffer.byteLength(entry.payload)),
    });
  }

  get(key: string): Envelope<unknown> | undefined {
    const entry = this.lru.get(key);
    if (!entry) return undefined;
    const now = this.clock.nowMs();
    if (entry.until <= now || entry.exp <= now) {
      this.lru.delete(key);
      return undefined;
    }
    const parsed = parseEnvelope<unknown>(entry.payload);
    return parsed.kind === 'ok' ? parsed.envelope : undefined;
  }

  has(key: string): boolean {
    const entry = this.lru.peek(key);
    if (!entry) return false;
    const now = this.clock.nowMs();
    return entry.until > now && entry.exp > now;
  }

  set(
    key: string,
    envelope: Envelope<unknown>,
    payload: string,
    ttlMs: number,
  ): void {
    this.lru.set(key, {
      payload,
      exp: envelope.exp,
      ver: envelope.ver,
      until: this.clock.nowMs() + ttlMs,
    });
  }

  delete(key: string): void {
    this.lru.delete(key);
  }

  /** Drops the copy unless it is already at `version` or newer (versioned broadcast). */
  dropIfOlder(key: string, version: number): void {
    const entry = this.lru.peek(key);
    if (entry && (entry.ver === undefined || entry.ver < version))
      this.lru.delete(key);
  }

  clear(): void {
    this.lru.clear();
  }

  get size(): number {
    return this.lru.size;
  }

  get bytes(): number {
    return this.lru.calculatedSize;
  }
}
