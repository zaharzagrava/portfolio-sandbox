import { Injectable } from '@nestjs/common';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { acceptBelowRank, rankOf } from '../domain/delivery-status';
import type {
  DeliveryRecord,
  DeliverySummary,
  DeliveryTimelineStore,
  DeliveryUpdate,
} from '../domain/ports';
import type { DeliveryStatus } from '../domain/types';
import { WIDE_COLUMN_TIMEOUT_MS, withTimeout } from './with-timeout';

/**
 * Wide-column adapter of `DELIVERY_TIMELINE_STORE`. `deliveries` is the summary row (one per delivery id, status moved
 * only forward by a conditional update on `status_rank`); `delivery_timeline` keeps one row per status move;
 * `deliveries_by_provider_id` maps a provider message id back to our delivery for callbacks. Details never hold a body,
 * an address or a token. Every call has a 1 s timeout.
 */
@Injectable()
export class CassandraDeliveryTimelineStore implements DeliveryTimelineStore {
  constructor(private readonly cassandra: CassandraService) {}

  private run(query: string, params: unknown[]) {
    return withTimeout(
      this.cassandra.execute(query, params),
      WIDE_COLUMN_TIMEOUT_MS,
      'delivery timeline',
    );
  }

  async begin(record: DeliveryRecord, at: Date): Promise<void> {
    const created = await this.run(
      `INSERT INTO deliveries (delivery_id, user_id, channel, type, line, status, status_rank, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?) IF NOT EXISTS`,
      [
        record.deliveryId,
        record.userId,
        record.channel,
        record.type,
        record.line,
        at,
      ],
    );
    // A replay finds the summary and adds no second `queued` row (the clustering key holds the time).
    if (created.wasApplied())
      await this.timelineRow(record.deliveryId, { status: 'queued', at });
  }

  private timelineRow(deliveryId: string, update: DeliveryUpdate) {
    return this.run(
      `INSERT INTO delivery_timeline (delivery_id, at, status, provider, provider_message_id, detail, failover)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        deliveryId,
        update.at,
        update.status,
        update.provider ?? null,
        update.providerMessageId ?? null,
        update.detail ?? null,
        update.failover ?? null,
      ],
    );
  }

  async advance(
    deliveryId: string,
    update: DeliveryUpdate,
  ): Promise<DeliveryStatus> {
    await this.timelineRow(deliveryId, update);
    const rank = rankOf(update.status);
    // Write only the columns this update carries: a status move must not blank the provider fields set earlier.
    const columns: string[] = [
      'status = ?',
      'status_rank = ?',
      'detail = ?',
      'updated_at = ?',
    ];
    const params: unknown[] = [
      update.status,
      rank,
      update.detail ?? null,
      update.at,
    ];
    if (update.provider !== undefined) {
      columns.push('provider = ?');
      params.push(update.provider);
    }
    if (update.providerMessageId !== undefined) {
      columns.push('provider_message_id = ?');
      params.push(update.providerMessageId);
    }
    if (update.failover !== undefined) {
      columns.push('failover = ?');
      params.push(update.failover);
    }
    const assignments = columns.join(', ');

    const first = await this.run(
      `UPDATE deliveries SET ${assignments} WHERE delivery_id = ? IF status_rank < ?`,
      [...params, deliveryId, acceptBelowRank(update.status)],
    );
    if (first.wasApplied()) return update.status;

    // A failed condition returns the column it tested: `null` = a row written before S28 (reads as rank 0),
    // `undefined` = no row at all.
    const seen = first.first()?.get('status_rank');
    if (seen === null) {
      const legacy = await this.run(
        `UPDATE deliveries SET ${assignments} WHERE delivery_id = ? IF status_rank = NULL`,
        [...params, deliveryId],
      );
      if (legacy.wasApplied()) return update.status;
    }
    if (seen === undefined) {
      // No summary row yet (a pre-send terminal reached the store first): create it at this status.
      const created = await this.run(
        `INSERT INTO deliveries (delivery_id, status, status_rank, detail, updated_at) VALUES (?, ?, ?, ?, ?) IF NOT EXISTS`,
        [deliveryId, update.status, rank, update.detail ?? null, update.at],
      );
      if (created.wasApplied()) return update.status;
    }
    return (await this.find(deliveryId))?.status ?? update.status;
  }

  async find(deliveryId: string): Promise<DeliverySummary | null> {
    const res = await this.run(
      `SELECT * FROM deliveries WHERE delivery_id = ?`,
      [deliveryId],
    );
    const row = res.first();
    if (!row) return null;
    return {
      deliveryId,
      userId:
        (row.get('user_id') as { toString(): string } | null)?.toString() ??
        null,
      channel: row.get('channel'),
      type: row.get('type'),
      line: row.get('line') ?? 'transactional',
      status: row.get('status'),
      provider: row.get('provider') ?? null,
      providerMessageId: row.get('provider_message_id') ?? null,
      updatedAt: row.get('updated_at'),
    };
  }

  async linkProvider(
    provider: string,
    providerMessageId: string,
    deliveryId: string,
  ): Promise<void> {
    await this.run(
      `INSERT INTO deliveries_by_provider_id (provider, provider_message_id, delivery_id) VALUES (?, ?, ?)`,
      [provider, providerMessageId, deliveryId],
    );
  }

  async findByProvider(
    provider: string,
    providerMessageId: string,
  ): Promise<string | null> {
    const res = await this.run(
      `SELECT delivery_id FROM deliveries_by_provider_id WHERE provider = ? AND provider_message_id = ?`,
      [provider, providerMessageId],
    );
    return (res.first()?.get('delivery_id') as string | undefined) ?? null;
  }
}
