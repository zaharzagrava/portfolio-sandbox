import { Injectable, Logger } from '@nestjs/common';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';

export type DeliveryStatus = 'queued' | 'delayed' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed' | 'capped';

/**
 * Delivery timeline in Scylla (write-heavy, read-by-key, 90-day TTL). Writes
 * are best-effort: a lost status row must never fail or retry a send.
 */
@Injectable()
export class DeliveryLogService {
  private readonly logger = new Logger(DeliveryLogService.name);

  constructor(private readonly cassandra: CassandraService) {}

  async record(entry: { deliveryId: string; userId: string; channel: string; type: string; status: DeliveryStatus; provider?: string; providerMessageId?: string; detail?: string }) {
    try {
      await this.cassandra.execute(
        `INSERT INTO deliveries (delivery_id, user_id, channel, type, provider, provider_message_id, status, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.deliveryId, entry.userId, entry.channel, entry.type, entry.provider ?? null, entry.providerMessageId ?? null, entry.status, entry.detail ?? null, new Date()],
      );
      if (entry.provider && entry.providerMessageId) {
        await this.cassandra.execute(`INSERT INTO deliveries_by_provider_id (provider, provider_message_id, delivery_id) VALUES (?, ?, ?)`, [entry.provider, entry.providerMessageId, entry.deliveryId]);
      }
    } catch (error) {
      this.logger.warn(`delivery log write failed: ${(error as Error).message}`);
    }
  }

  /** Provider callback → our delivery (status only; other columns keep their values). */
  async updateByProviderId(provider: string, providerMessageId: string, status: DeliveryStatus, detail?: string): Promise<string | null> {
    const res = await this.cassandra.execute(`SELECT delivery_id FROM deliveries_by_provider_id WHERE provider = ? AND provider_message_id = ?`, [provider, providerMessageId]);
    const deliveryId = res.first()?.get('delivery_id') as string | undefined;
    if (!deliveryId) return null;
    await this.cassandra.execute(`UPDATE deliveries SET status = ?, detail = ?, updated_at = ? WHERE delivery_id = ?`, [status, detail ?? null, new Date(), deliveryId]);
    return deliveryId;
  }

  async get(deliveryId: string) {
    const res = await this.cassandra.execute(`SELECT * FROM deliveries WHERE delivery_id = ?`, [deliveryId]);
    return res.first() ?? null;
  }
}
