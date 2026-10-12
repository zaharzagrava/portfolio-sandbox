import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { ApiConfigService } from '@app/common/config';
import { ShopCellService } from '../application/shop-cell.service';
import {
  DEFAULT_CELL_ACQUIRE_TIMEOUT_MS,
  DEFAULT_CELL_POOL_MAX,
  parseCells,
  POOLED_CELL,
} from '../domain/cell-config';
import { Domain_CellUnavailableError } from '../domain/errors';
import './tenancy-config.rules';

/**
 * Hybrid isolation (lesson 10/04 #2): most shops share the pooled database; a shop that outgrows it (or buys
 * "dedicated") lives in its own cell. Domain code asks the resolver for "the connection for this shop", so moving a
 * tenant is a data migration plus a `ShopDirectory` update, no code change in any other domain.
 *
 * Fail closed (FR-051): a cell this process has no connection for, one that does not answer, or one whose pool stays
 * full for the acquire timeout is `503 cell_unavailable`. It is never the pooled database. Each cell has its own
 * bounded pool, so a saturated cell affects only its shops. Cells come from validated configuration
 * (`tenancy_cells`), never from `process.env` at call time.
 */
@Injectable()
export class TenantConnectionResolver implements OnModuleDestroy {
  private readonly logger = new Logger(TenantConnectionResolver.name);
  private readonly urls: Record<string, string>;
  private readonly pools = new Map<string, Sequelize>();
  private readonly poolMax: number;
  private readonly acquireMs: number;
  private readonly statementTimeoutMs: number;

  constructor(
    @InjectConnection() private readonly pooled: Sequelize,
    private readonly cells: ShopCellService,
    config: ApiConfigService,
  ) {
    this.urls = parseCells(config.get('tenancy_cells')) ?? {};
    this.poolMax = config.get('tenancy_cell_pool_max') ?? DEFAULT_CELL_POOL_MAX;
    this.acquireMs =
      config.get('tenancy_cell_acquire_timeout_ms') ??
      DEFAULT_CELL_ACQUIRE_TIMEOUT_MS;
    this.statementTimeoutMs = config.get('db_statement_timeout_ms') ?? 30_000;
  }

  async cellOf(shopId: string): Promise<string> {
    return (await this.cells.cellOf(shopId)).cell;
  }

  async connectionFor(shopId: string): Promise<Sequelize> {
    const { cell } = await this.cells.cellOf(shopId);
    if (cell === POOLED_CELL) return this.pooled;
    const pool = this.poolOf(cell);
    if (!pool) throw new Domain_CellUnavailableError();
    // Check a connection out and straight back: a full or unreachable cell fails here, within the acquire timeout,
    // instead of in the middle of the caller's work.
    try {
      const connection = await pool.connectionManager.getConnection({
        type: 'read',
      });
      pool.connectionManager.releaseConnection(connection);
    } catch (error) {
      this.logger.warn({
        event: 'cell.unavailable',
        cell,
        error: (error as Error).name,
      });
      throw new Domain_CellUnavailableError();
    }
    return pool;
  }

  /** The pools opened so far, by cell name (for the startup `statement_timeout` check). */
  openPools(): ReadonlyMap<string, Sequelize> {
    return this.pools;
  }

  private poolOf(cell: string): Sequelize | undefined {
    const url = this.urls[cell];
    if (!url) return undefined;
    let pool = this.pools.get(cell);
    if (!pool) {
      pool = new Sequelize(url, {
        dialect: 'postgres',
        logging: false,
        pool: { max: this.poolMax, min: 0, acquire: this.acquireMs },
        dialectOptions: { statement_timeout: this.statementTimeoutMs },
      });
      this.pools.set(cell, pool);
    }
    return pool;
  }

  async onModuleDestroy() {
    await Promise.all([...this.pools.values()].map((c) => c.close()));
  }
}
