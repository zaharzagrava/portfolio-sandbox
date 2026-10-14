import { Injectable } from '@nestjs/common';
import { UsageBucketRepository } from '../domain/ports';
import { billableUnits, bucketMinute } from '../domain/usage-bucket';

/**
 * Turns request records into billable minutes (FR-058, AS-64): billable = served live calls below 500 and not 429, cost
 * weighted. The record's event id makes a redelivery a no-op; a record for a minute already emitted opens the next sequence.
 */
@Injectable()
export class UsageMeteringHandler {
  constructor(private readonly buckets: UsageBucketRepository) {}

  async record(input: {
    eventId: string;
    requestId: string;
    shopId: string;
    livemode: boolean;
    status: number;
    cost: number;
    at: Date;
  }): Promise<'added' | 'duplicate' | 'not_billable'> {
    const quantity = billableUnits({
      requestId: input.requestId,
      shopId: input.shopId,
      livemode: input.livemode,
      status: input.status,
      cost: input.cost,
      ts: input.at,
    });
    if (quantity === 0) return 'not_billable';
    return this.buckets.add({
      eventId: input.eventId,
      shopId: input.shopId,
      minute: bucketMinute(input.at),
      quantity,
    });
  }
}
