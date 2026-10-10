import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  isCrossTenantReason,
  type CrossTenantReason,
} from '../domain/cross-tenant-reason';
import { crossTenantCounter } from '../domain/tenancy-metrics';

/**
 * Transactions with the Postgres RLS tenant set (`app.shop_id`, optionally `app.user_id`, transaction scoped → safe
 * with PgBouncer transaction pooling). The application-level `WHERE "shopId" = ...` is the primary control; RLS is the
 * backstop that makes a forgotten WHERE return nothing instead of another tenant's rows.
 */
@Injectable()
export class ShopTransactionRunner {
  private readonly logger = new Logger('CrossTenant');

  constructor(
    private readonly runner: TransactionRunner,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  inShop<T>(
    shopId: string,
    fn: (tx: Transaction) => Promise<T>,
    options: { userId?: string } = {},
  ): Promise<T> {
    return this.runner.run(async (tx) => {
      await this.sequelize.query(
        `SELECT set_config('app.shop_id', $1, true), set_config('app.user_id', $2, true)`,
        { bind: [shopId, options.userId ?? ''], transaction: tx },
      );
      return fn(tx);
    });
  }

  /** "Which shops am I in?": the membership rows of one user are visible without a shop context. */
  asUser<T>(userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.runner.run(async (tx) => {
      await this.sequelize.query(`SELECT set_config('app.user_id', $1, true)`, {
        bind: [userId],
        transaction: tx,
      });
      return fn(tx);
    });
  }

  /**
   * Explicit, audited bypass for system paths that legitimately cross tenants (invite acceptance by token, SSO
   * provisioning, purge, legacy provisioning). A reason outside the allowlist throws before any query. The setting is
   * transaction-local, so it is gone when the transaction ends.
   */
  async crossTenant<T>(
    reason: CrossTenantReason,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    if (!isCrossTenantReason(reason))
      throw new Error(`cross-tenant reason "${String(reason)}" is not allowed`);
    return this.runner.run(async (tx) => {
      await this.sequelize.query(
        `SELECT set_config('app.rls_bypass', 'on', true), set_config('app.rls_bypass_reason', $1, true)`,
        { bind: [reason], transaction: tx },
      );
      crossTenantCounter.add(1, { reason });
      this.logger.log({ event: 'rls.bypass', reason });
      return fn(tx);
    });
  }
}
