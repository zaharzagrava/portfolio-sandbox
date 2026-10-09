import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { PlatformCodes } from '@app/common/errors/platform-codes';
import { getActiveTransaction } from './transaction-scope';
import {
  resolveTransactionOptions,
  RunInTransactionOptions,
} from './transaction-options';

export type { RunInTransactionOptions } from './transaction-options';

const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

/**
 * Single entry point for "do these things atomically". The transaction is propagated via CLS
 * (see sequelize-cls.ts), so any model call inside `fn` joins it automatically, and a nested `run`
 * joins the active transaction unless `propagation: 'requires_new'` is asked for.
 */
@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger(TransactionRunner.name);
  /** Lets the `@Transactional` decorator (which cannot be injected) reach the runner of the running app. */
  static current: TransactionRunner | undefined;

  constructor(@InjectConnection() private readonly sequelize: Sequelize) {
    TransactionRunner.current = this;
  }

  async run<T>(
    fn: (tx: Transaction) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<T> {
    const o = resolveTransactionOptions(options);
    const active = getActiveTransaction();
    if (active && o.propagation === 'join') return fn(active);

    return this.sequelize.transaction(
      { isolationLevel: o.isolationLevel },
      async (tx) => {
        // Bound values, never interpolated; `true` = local to this transaction.
        if (o.lockTimeoutMs !== undefined) {
          await this.sequelize.query('select set_config($1, $2, true)', {
            bind: ['lock_timeout', `${o.lockTimeoutMs}ms`],
            transaction: tx,
          });
        }
        if (o.statementTimeoutMs !== undefined) {
          await this.sequelize.query('select set_config($1, $2, true)', {
            bind: ['statement_timeout', `${o.statementTimeoutMs}ms`],
            transaction: tx,
          });
        }
        return fn(tx);
      },
    );
  }

  /**
   * SERIALIZABLE + retry (at most 3 attempts) on serialization failures/deadlocks. Use for invariants spanning
   * several rows that row locks can't express (write skew), e.g. "a shop must keep at least one owner" (SD-02).
   * Refuses to start inside another transaction: the isolation level cannot be raised mid-way.
   */
  async runSerializable<T>(
    fn: (tx: Transaction) => Promise<T>,
    options: { maxAttempts?: number } = {},
  ): Promise<T> {
    if (getActiveTransaction())
      throw new Error(
        'runSerializable cannot start inside an active transaction',
      );
    const { maxAttempts } = resolveTransactionOptions({
      maxAttempts: options.maxAttempts ?? 3,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.run(fn, {
          isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
        });
      } catch (error) {
        const code =
          (
            error as {
              parent?: { code?: string };
              original?: { code?: string };
            }
          )?.parent?.code ??
          (error as { original?: { code?: string } })?.original?.code;
        const retryable =
          code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
        if (!retryable) throw error;
        if (attempt + 1 >= maxAttempts) {
          throw new AppError({
            code: PlatformCodes.transaction_conflict,
            status: HttpStatus.SERVICE_UNAVAILABLE,
            title: 'Service Unavailable',
            detail:
              'The request conflicted with a concurrent update. Please retry.',
            area: ErrorArea.TRANSIENT,
            retryAfterSeconds: 1,
            causes: [error as Error],
          });
        }

        const delay = fullJitterBackoff(attempt, { baseMs: 10, maxMs: 200 });
        this.logger.warn(
          `Serializable tx retry #${attempt + 1} after ${delay}ms (code ${code})`,
        );
        await sleep(delay);
      }
    }
  }
}
