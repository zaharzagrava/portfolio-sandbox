import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { decodeHlc, encodeHlc, plausible, receive, tick } from '../domain/hlc';
import { stockDelta, SyncOp, winningFields } from '../domain/merge';

export type OpResult = { opId: string; result: 'applied' | 'merged' | 'duplicate' | 'conflict' | 'rejected'; detail?: Record<string, unknown> };

const PULL_LIMIT = 500;

/**
 * Offline-first sync (10/04 #6), backend half.
 * PUSH: each op in its own transaction: claim the opId (INSERT ... ON CONFLICT
 * DO NOTHING) → apply its merge rule → done; a replayed batch hits the claim
 * and changes nothing. Ops for other shops' products are rejected (tenant
 * from the guard, never from the payload).
 * PULL: everything in the shop's change log after the device's cursor - the
 * device's whole view of the world is "apply changes in seq order".
 */
@Injectable()
export class SyncService {
  private serverClock = { physical: 0, logical: 0, node: 'server' };

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly outbox: OutboxService,
  ) {}

  async push(shopId: string, deviceId: string, ops: SyncOp[]) {
    const results: OpResult[] = [];
    for (const op of ops) results.push(await this.apply(shopId, deviceId, op));
    this.serverClock = tick(this.serverClock, Date.now());
    return { results, serverHlc: encodeHlc(this.serverClock) };
  }

  async pull(shopId: string, cursor: number, limit = PULL_LIMIT) {
    const rows = await this.sequelize.query<{ seq: string; entity: string; entityId: string; data: object }>(
      `SELECT seq, entity, "entityId", data FROM "ShopChangeLog" WHERE "shopId" = :shopId AND seq > :cursor ORDER BY seq LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { shopId, cursor, limit: Math.min(limit, PULL_LIMIT) + 1 } },
    );
    const page = rows.slice(0, Math.min(limit, PULL_LIMIT));
    return {
      changes: page.map((r) => ({ seq: Number(r.seq), entity: r.entity, id: r.entityId, data: r.data })),
      cursor: page.length ? Number(page[page.length - 1].seq) : cursor,
      hasMore: rows.length > page.length,
    };
  }

  conflicts(shopId: string) {
    return this.sequelize.query(`SELECT "opId", "deviceId", type, hlc, detail, "appliedAt" FROM "SyncOperation" WHERE "shopId" = :shopId AND result = 'conflict' ORDER BY "appliedAt" DESC LIMIT 200`, {
      type: QueryTypes.SELECT,
      replacements: { shopId },
    });
  }

  private async apply(shopId: string, deviceId: string, op: SyncOp): Promise<OpResult> {
    const hlc = decodeHlc(op.hlc);
    if (!hlc || !plausible(hlc, Date.now())) return { opId: op.opId, result: 'rejected', detail: { reason: 'implausible clock' } };
    this.serverClock = receive(this.serverClock, hlc, Date.now());

    return this.sequelize.transaction(async (transaction) => {
      const [claimed] = await this.sequelize.query(
        `INSERT INTO "SyncOperation" ("opId", "shopId", "deviceId", type, hlc, result) VALUES (:opId, :shopId, :deviceId, :type, :hlc, 'pending') ON CONFLICT ("opId") DO NOTHING RETURNING "opId"`,
        { type: QueryTypes.SELECT, replacements: { opId: op.opId, shopId, deviceId, type: op.type, hlc: op.hlc }, transaction },
      );
      if (!claimed) return { opId: op.opId, result: 'duplicate' as const };

      const outcome = await this.applyOp(shopId, op, transaction);
      await this.sequelize.query(`UPDATE "SyncOperation" SET result = :result, detail = CAST(:detail AS jsonb) WHERE "opId" = :opId`, {
        replacements: { result: outcome.result, detail: outcome.detail ? JSON.stringify(outcome.detail) : null, opId: op.opId },
        transaction,
      });
      return { opId: op.opId, ...outcome };
    });
  }

  private async applyOp(shopId: string, op: SyncOp, transaction: Transaction): Promise<Omit<OpResult, 'opId'>> {
    if (op.type === 'stock.adjust' || op.type === 'stock.count') {
      const delta = stockDelta(op);
      if (!Number.isInteger(delta)) throw new BadRequestException('integer stock deltas only');
      const [row] = await this.sequelize.query<{ quantity: number }>(
        `UPDATE "Product" SET quantity = quantity + :delta, version = version + 1, "updatedAt" = now() WHERE id = :productId AND "shopId" = :shopId RETURNING quantity`,
        { type: QueryTypes.SELECT, replacements: { delta, productId: op.productId, shopId }, transaction },
      );
      if (!row) return { result: 'rejected', detail: { reason: 'unknown product' } };
      await this.outbox.notify({ topic: KafkaTopicGroup.PRODUCTS_EVENTS, payload: { productId: op.productId }, aggregateId: op.productId }, transaction);
      // Deltas always apply (they commute); going negative means two devices sold the same last unit - a human decides.
      return row.quantity < 0 ? { result: 'conflict', detail: { reason: 'oversold', quantity: row.quantity, delta } } : { result: 'applied', detail: { quantity: row.quantity } };
    }

    const clocks = await this.sequelize.query<{ field: string; hlc: string }>(`SELECT field, hlc FROM "ProductFieldClock" WHERE "productId" = :productId FOR UPDATE`, {
      type: QueryTypes.SELECT,
      replacements: { productId: op.productId },
      transaction,
    });
    const { win, lose } = winningFields(op.fields, op.hlc, Object.fromEntries(clocks.map((c) => [c.field, c.hlc])));
    if (win.length) {
      const sets = win.map((f) => `"${f}" = :${f}`).join(', ');
      const [updated] = await this.sequelize.query(`UPDATE "Product" SET ${sets}, version = version + 1, "updatedAt" = now() WHERE id = :productId AND "shopId" = :shopId RETURNING id`, {
        type: QueryTypes.SELECT,
        replacements: { ...Object.fromEntries(win.map((f) => [f, op.fields[f as keyof typeof op.fields]])), productId: op.productId, shopId },
        transaction,
      });
      if (!updated) return { result: 'rejected', detail: { reason: 'unknown product' } };
      for (const field of win) {
        await this.sequelize.query(`INSERT INTO "ProductFieldClock" ("productId", field, hlc) VALUES (:productId, :field, :hlc) ON CONFLICT ("productId", field) DO UPDATE SET hlc = EXCLUDED.hlc`, {
          replacements: { productId: op.productId, field, hlc: op.hlc },
          transaction,
        });
      }
      await this.outbox.notify({ topic: KafkaTopicGroup.PRODUCTS_EVENTS, payload: { productId: op.productId }, aggregateId: op.productId }, transaction);
    }
    return lose.length ? { result: 'merged', detail: { applied: win, superseded: lose } } : { result: 'applied', detail: { applied: win } };
  }
}
