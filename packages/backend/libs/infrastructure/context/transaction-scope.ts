import { Logger } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { sequelizeClsNamespace } from './sequelize-cls';

const logger = new Logger('TransactionScope');

/** The transaction the current async chain runs in, if any. */
export const getActiveTransaction = (): Transaction | undefined =>
  (sequelizeClsNamespace.get('transaction') as Transaction | undefined) ??
  undefined;

/** For code that must only run inside a scope (e.g. appending to the outbox). Programmer error otherwise. */
export function assertActiveTransaction(): Transaction {
  const tx = getActiveTransaction();
  if (!tx)
    throw new Error(
      'This operation must run inside a transaction scope (TransactionRunner.run / @Transactional)',
    );
  return tx;
}

/** Counter hook for the network-in-transaction guard; wired to the metrics registry in a later task. */
export const networkGuardStats = { refused: 0 };

/** Called by outbound network clients: calling out while a transaction holds a connection is a bug (constitution III.3). */
export function assertNoActiveTransaction(kind: 'network'): void {
  if (getActiveTransaction()) {
    networkGuardStats.refused++;
    throw new Error(
      `A ${kind} call is not allowed inside a transaction; move it to afterCommit`,
    );
  }
}

/**
 * Runs `callback` once, after the active transaction commits, in registration order. A failing callback is logged
 * and does not stop the others. Outside a transaction it runs immediately. Nothing runs on rollback.
 */
export function afterCommit(callback: () => void | Promise<void>): void {
  const tx = getActiveTransaction();
  const safe = async () => {
    try {
      await callback();
    } catch (error) {
      logger.error(
        `afterCommit callback failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  };
  // The finished transaction must not leak into the callback's own queries.
  const detached = () =>
    sequelizeClsNamespace.run((context) => {
      context.set('transaction', undefined);
      return safe();
    });
  if (tx) tx.afterCommit(detached);
  else void detached();
}
