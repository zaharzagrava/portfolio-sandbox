import { RedisService } from '@app/infrastructure/redis/redis.service';

/**
 * Ticket-server style id allocation: each instance leases a block of ids with
 * one Redis INCRBY and hands them out locally - 1 round trip per 1,000 links
 * instead of per link, and instances never coordinate. Ids skipped by a
 * crashed instance's unused block are simply never used (gaps are harmless).
 */
export class IdLease {
  private next = 0;
  private end = 0;
  private pending?: Promise<void>;

  constructor(
    private readonly redis: RedisService,
    private readonly key: string,
    private readonly blockSize = 1_000,
  ) {}

  async nextId(): Promise<number> {
    while (this.next >= this.end) {
      this.pending ??= this.lease().finally(() => (this.pending = undefined));
      await this.pending;
    }
    return this.next++;
  }

  private async lease() {
    const end = await this.redis.client.incrby(this.key, this.blockSize);
    this.next = end - this.blockSize + 1;
    this.end = end + 1;
  }
}
