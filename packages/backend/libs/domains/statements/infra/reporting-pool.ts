import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Environment } from '@app/common/types';

/**
 * Dedicated, small pg pool for long-running reads (exports, statements),
 * pointed at the READ REPLICA when one is configured (lesson 03/03 §3):
 * a 2-minute CSV export must neither hold an OLTP pool connection nor load
 * the primary. Replica lag is acceptable here (closed months don't change).
 */
@Injectable()
export class ReportingPool implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(config: ApiConfigService) {
    this.pool = new Pool({
      host: config.get('db_read_host') || config.get('db_host'),
      port: Number(config.get('db_port')),
      user: config.get('db_username'),
      password: config.get('db_password'),
      database: config.get('db_name'),
      max: 5,
      statement_timeout: 300_000,
      application_name: 'reporting',
      ...(config.get('node_env') === Environment.production && { ssl: { rejectUnauthorized: false } }),
    });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
