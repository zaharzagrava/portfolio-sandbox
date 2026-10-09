import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';

/**
 * Transactions with the Postgres RLS tenant set (`app.shop_id`, transaction
 * scoped → safe with PgBouncer transaction pooling). The application-level
 * `WHERE "shopId" = ...` is the primary control; RLS is the backstop that
 * makes a forgotten WHERE return nothing instead of another tenant's rows.
 */
@Injectable()
export class ShopTransactionRunner {
  constructor(
    private readonly runner: TransactionRunner,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  inShop<T>(shopId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.runner.run(async (tx) => {
      await this.sequelize.query(
        `SELECT set_config('app.shop_id', :shopId, true)`,
        { replacements: { shopId }, transaction: tx },
      );
      return fn(tx);
    });
  }

  /** Explicit, auditable bypass for system paths that legitimately cross tenants (invite acceptance by token, backfills). */
  crossTenant<T>(
    reason: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run(async (tx) => {
      await this.sequelize.query(
        `SELECT set_config('app.rls_bypass', 'on', true), set_config('app.rls_bypass_reason', :reason, true)`,
        {
          replacements: { reason },
          transaction: tx,
        },
      );
      return fn(tx);
    });
  }
}
