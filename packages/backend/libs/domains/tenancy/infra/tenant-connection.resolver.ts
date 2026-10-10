import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import ShopDirectory from './models/shop-directory.model';
import { CacheService } from '@app/infrastructure/cache/cache.service';

/**
 * Hybrid isolation (lesson 10/04 #2): most shops share the pooled database;
 * a shop that outgrows it (or buys "dedicated") is moved to its own cell.
 * Domain code asks the resolver for "the connection for this shop" instead of
 * hard-wiring the default one, so moving a tenant is a data migration plus a
 * ShopDirectory row update - no code change. Cells come from
 * TENANT_CELLS='{"dedicated-1":"postgres://..."}'.
 */
@Injectable()
export class TenantConnectionResolver implements OnModuleDestroy {
  private readonly cells = new Map<string, Sequelize>();
  private readonly cellUrls: Record<string, string>;

  constructor(
    @InjectConnection() private readonly pooled: Sequelize,
    @InjectModel(ShopDirectory)
    private readonly directory: typeof ShopDirectory,
    private readonly cache: CacheService,
  ) {
    this.cellUrls = JSON.parse(process.env.TENANT_CELLS ?? '{}');
  }

  async cellOf(shopId: string): Promise<string> {
    return (
      (await this.cache.getOrLoad(
        `shop-cell:v1:${shopId}`,
        async () =>
          (await this.directory.findByPk(shopId, { raw: true }))?.cell ??
          'pooled',
        { ttlMs: 300_000, l1: 'always', l1TtlMs: 5_000 },
      )) ?? 'pooled'
    );
  }

  async connectionFor(shopId: string): Promise<Sequelize> {
    const cell = await this.cellOf(shopId);
    if (cell === 'pooled' || !this.cellUrls[cell]) return this.pooled;
    let connection = this.cells.get(cell);
    if (!connection) {
      connection = new Sequelize(this.cellUrls[cell], {
        dialect: 'postgres',
        logging: false,
        pool: { max: 10 },
      });
      this.cells.set(cell, connection);
    }
    return connection;
  }

  async onModuleDestroy() {
    await Promise.all([...this.cells.values()].map((c) => c.close()));
  }
}
