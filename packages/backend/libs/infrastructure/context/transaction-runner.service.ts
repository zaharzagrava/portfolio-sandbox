import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';

export interface RunInTransactionOptions {
  isolationLevel?: Transaction.ISOLATION_LEVELS;
  /** Postgres-side guard against long lock waits blocking the pool. */
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

/**
 * Single entry point for "do these things atomically". The transaction is
 * propagated via CLS (see sequelize-cls.ts), so any model call inside `fn`
 * joins it automatically.
 */
@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger(TransactionRunner.name);

  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async run<T>(fn: (tx: Transaction) => Promise<T>, options: RunInTransactionOptions = {}): Promise<T> {
    return this.sequelize.transaction({ isolationLevel: options.isolationLevel }, async (tx) => {
      if (options.lockTimeoutMs) {
        await this.sequelize.query(`SET LOCAL lock_timeout = '${Math.trunc(options.lockTimeoutMs)}ms'`, { transaction: tx });
      }
      if (options.statementTimeoutMs) {
        await this.sequelize.query(`SET LOCAL statement_timeout = '${Math.trunc(options.statementTimeoutMs)}ms'`, {
          transaction: tx,
        });
      }
      return fn(tx);
    });
  }

  /**
   * SERIALIZABLE + retry on serialization failures/deadlocks. Use for
   * invariants spanning several rows that row locks can't express (write
   * skew), e.g. "a shop must keep at least one owner" (SD-02).
   */
  async runSerializable<T>(fn: (tx: Transaction) => Promise<T>, maxAttempts = 5): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.run(fn, { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
      } catch (error) {
        const code = (error as { parent?: { code?: string } })?.parent?.code;
        const retryable = code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
        if (!retryable || attempt + 1 >= maxAttempts) throw error;

        const delay = fullJitterBackoff(attempt, { baseMs: 10, maxMs: 200 });
        this.logger.warn(`Serializable tx retry #${attempt + 1} after ${delay}ms (code ${code})`);
        await sleep(delay);
      }
    }
  }
}
