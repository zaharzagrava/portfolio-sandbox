import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProductEditLock } from '../domain/ports';

interface PgConnection {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface ConnectionManager {
  getConnection(options?: { type?: string }): Promise<PgConnection>;
  releaseConnection(connection: PgConnection): Promise<void>;
}

/**
 * Per-product serialisation of field decisions (R-04): a session-level advisory lock held on a pooled connection of its
 * own. It is not a database transaction (`sequelize.transaction` is not used, so the S54 audit count stays 0), and the
 * connection is taken outside the CLS scope, so the catalog calls made under the lock never join a transaction of this
 * capability. If the process dies the connection closes and Postgres frees the lock.
 *
 * A waiter holds a connection only while it tries; at most half of the pool can be held by lock owners at once, so an
 * owner that needs a second connection for its catalog call can always get one.
 */
@Injectable()
export class PgAdvisoryProductEditLock implements ProductEditLock {
  private holders = 0;
  private readonly maxHolders: number;

  constructor(@InjectConnection() private readonly db: Sequelize) {
    const poolMax = Number(
      (this.db.config as { pool?: { max?: number } }).pool?.max ?? 10,
    );
    this.maxHolders = Math.max(1, Math.floor(poolMax / 2));
  }

  async withLock<T>(
    shopId: string,
    productId: string,
    waitMs: number,
    work: () => Promise<T>,
  ): Promise<{ kind: 'locked'; value: T } | { kind: 'timeout' }> {
    const giveUpAt = Date.now() + waitMs;
    const manager = (
      this.db as unknown as { connectionManager: ConnectionManager }
    ).connectionManager;
    const key = `sync-field:${shopId}:${productId}`;
    for (;;) {
      if (this.holders < this.maxHolders) {
        const connection = await manager.getConnection({ type: 'write' });
        let held = false;
        try {
          const { rows } = await connection.query(
            `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
            [key],
          );
          held = rows[0]?.locked === true;
          if (held) {
            this.holders++;
            try {
              return { kind: 'locked', value: await work() };
            } finally {
              this.holders--;
              await connection
                .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
                  key,
                ])
                .catch(() => undefined);
            }
          }
        } finally {
          await manager.releaseConnection(connection);
        }
      }
      if (Date.now() >= giveUpAt) return { kind: 'timeout' };
      await sleep(5 + Math.floor(Math.random() * 20));
    }
  }
}
