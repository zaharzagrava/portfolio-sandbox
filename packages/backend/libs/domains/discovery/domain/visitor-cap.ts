import { murmur3 } from '@app/common/core/murmur3';

const HASHES = 7;

/**
 * A Bloom filter over `bits` bits (a power of two): no false "unseen", a small false "seen" rate (about 1% at 9.6 bits per
 * entry with 7 hashes). Probe positions are derived from two murmur3 hashes (Kirsch-Mitzenmacher double hashing). Only
 * hashes are held: the keys themselves are never stored.
 */
export class BloomFilter {
  private readonly bitset: Uint8Array;
  private readonly mask: number;

  constructor(readonly bits: number) {
    this.bitset = new Uint8Array(bits >> 3);
    this.mask = bits - 1;
  }

  get byteSize(): number {
    return this.bitset.byteLength;
  }

  add(key: string): void {
    const h1 = murmur3(key, 0);
    const h2 = murmur3(key, 0x9e3779b1) | 1;
    for (let i = 0; i < HASHES; i++) {
      const bit = (h1 + Math.imul(i, h2)) & this.mask;
      this.bitset[bit >> 3] |= 1 << (bit & 7);
    }
  }

  has(key: string): boolean {
    const h1 = murmur3(key, 0);
    const h2 = murmur3(key, 0x9e3779b1) | 1;
    for (let i = 0; i < HASHES; i++) {
      const bit = (h1 + Math.imul(i, h2)) & this.mask;
      if ((this.bitset[bit >> 3] & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }
}

export type Admission = 'fresh' | 'duplicate' | 'visitor_capped';

/**
 * The two membership checks of one open window of one partition (S35 FR-015, R-7): `event_id` already seen (a redelivery,
 * `duplicate`) and (visitor, event name, product) already seen in this window (`visitor_capped`). A new window gets a new
 * pair of filters, so the cap is per window; the filters are dropped when the window merges. A false "seen" slightly
 * undercounts, which approximate counting tolerates; there is never a false "unseen".
 */
export class WindowCaps {
  private readonly events: BloomFilter;
  private readonly visitors: BloomFilter;

  constructor(bits: number) {
    this.events = new BloomFilter(bits);
    this.visitors = new BloomFilter(bits);
  }

  get byteSize(): number {
    return this.events.byteSize + this.visitors.byteSize;
  }

  admit(
    eventId: string,
    visitorId: string,
    name: string,
    productId: string,
  ): Admission {
    if (this.events.has(eventId)) return 'duplicate';
    this.events.add(eventId);
    const key = `${visitorId}\u0000${name}\u0000${productId}`;
    if (this.visitors.has(key)) return 'visitor_capped';
    this.visitors.add(key);
    return 'fresh';
  }
}
