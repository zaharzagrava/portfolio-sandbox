import { metrics } from '@opentelemetry/api';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import FlashSale from './models/flash-sale.model';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import { FlashStockService } from './flash-stock.service';

import '../application/order.job-types';

/**
 * Flash-sale lifecycle (legacy, parked until S11 replaces flash sales): moves a drop's units out of the catalog's stock
 * into Redis buckets before the start and back after the end. Not part of the checkout path.
 */
@Injectable()
export class FlashSaleJobs {
  private readonly logger = new Logger(FlashSaleJobs.name);

  constructor(
    @InjectModel(FlashSale) private readonly saleModel: typeof FlashSale,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly flash: FlashStockService,
    private readonly jobs: JobsService,
    private readonly tx: TransactionRunner,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Moves the drop's units out of Postgres stock into Redis buckets, atomically w.r.t. other buyers. */
  @JobHandler('flash-sale.start', { concurrency: 5 })
  async start({ saleId }: { saleId: string }) {
    const sale = await this.saleModel.findByPk(saleId);
    if (!sale || sale.status !== 'SCHEDULED') return;

    const [rows] = await this.sequelize.query(
      `UPDATE "Product" SET quantity = quantity - :units, version = version + 1 WHERE id = :productId AND quantity >= :units RETURNING id`,
      { replacements: { units: sale.units, productId: sale.productId } },
    );
    if (rows.length === 0)
      throw new NonRetryableJobError(
        `not enough stock to start flash sale ${saleId}`,
      );

    await this.flash.load({
      saleId,
      productId: sale.productId,
      price: Number(sale.price),
      buckets: sale.buckets,
      perUserLimit: sale.perUserLimit,
      endsAt: sale.endsAt.toISOString(),
      units: sale.units,
    });
    await sale.update({ status: 'LIVE' });
  }

  @JobHandler('flash-sale.end', { concurrency: 5 })
  async end({ saleId }: { saleId: string }) {
    const sale = await this.saleModel.findByPk(saleId);
    if (!sale || sale.status !== 'LIVE') return;
    await this.flash.deactivate(sale.productId);
    await sale.update({ status: 'ENDED' });
    // After every hold taken during the sale has either converted or expired.
    await this.jobs.enqueue(
      'flash-sale.reconcile',
      { saleId },
      {
        runAt: new Date(
          this.clock.now().getTime() +
            this.config.get('orders_hold_seconds') * 1000 +
            60_000,
        ),
        idempotencyKey: `flash-reconcile:${saleId}`,
      },
    );
  }

  /**
   * Postgres is the truth for what was SOLD (converted reservations); Redis
   * only for what was available. Unsold units go back to Product.quantity.
   * A mismatch means Redis lost writes (failover) - logged as drift, the DB wins.
   */
  private readonly drift = metrics
    .getMeter('orders')
    .createCounter('flash_sale_stock_drift_units_total', {
      description:
        'Units by which Redis flash stock disagreed with Postgres at reconciliation',
    });

  @JobHandler('flash-sale.reconcile', { concurrency: 1 })
  async reconcile({ saleId }: { saleId: string }) {
    const sale = await this.saleModel.findByPk(saleId);
    if (!sale || sale.status !== 'ENDED') return;

    const [{ held, sold }] = await this.sequelize.query<{
      held: number;
      sold: number;
    }>(
      `SELECT coalesce(sum(quantity) FILTER (WHERE status = 'HELD'), 0)::int AS held,
              coalesce(sum(quantity) FILTER (WHERE status = 'CONVERTED'), 0)::int AS sold
       FROM "StockReservation" WHERE "flashSaleId" = :saleId`,
      { type: QueryTypes.SELECT, replacements: { saleId } },
    );
    if (held > 0)
      throw new Error(
        `${held} units still held for sale ${saleId}; retrying later`,
      );

    const redisRemaining = await this.flash.remaining(saleId, sale.buckets);
    const unsold = sale.units - sold;
    if (redisRemaining !== unsold) {
      this.logger.warn(
        `flash sale ${saleId} drift: redis=${redisRemaining} db-derived=${unsold} (DB wins)`,
      );
      // Alert FlashSaleStockDrift (O-01 runbook): Redis lost writes - possible oversell window during the sale.
      this.drift.add(Math.abs(redisRemaining - unsold), {
        direction: redisRemaining < unsold ? 'redis_low' : 'redis_high',
      });
    }

    await this.tx.run(async (transaction) => {
      await this.sequelize.query(
        `UPDATE "Product" SET quantity = quantity + :unsold, version = version + 1 WHERE id = :productId`,
        {
          replacements: { unsold, productId: sale.productId },
          transaction,
        },
      );
      await sale.update({ status: 'RECONCILED' }, { transaction });
    });
  }
}
