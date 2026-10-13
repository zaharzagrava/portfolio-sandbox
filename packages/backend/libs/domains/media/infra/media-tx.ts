import type { SqlRunner, Tx } from '../domain/ports';
import { PgGalleryRepository } from './pg-gallery-repository';
import { PgMediaRepository } from './pg-media-repository';

/**
 * Builds the `Tx` the processor needs from a function that runs `fn` inside one database transaction and hands it a
 * `SqlRunner` bound to it. The Lambda supplies one over a `pg` client (`BEGIN`/`COMMIT`); Nest uses the CLS-bound
 * `SequelizeMediaStore` instead. The repositories stay internal to the domain.
 */
export const createTx =
  (transaction: <T>(fn: (sql: SqlRunner) => Promise<T>) => Promise<T>): Tx =>
  (fn) =>
    transaction((sql) =>
      fn({
        media: new PgMediaRepository(sql),
        gallery: new PgGalleryRepository(sql),
      }),
    );
