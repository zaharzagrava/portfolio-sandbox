import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { ApiConfigService } from '@app/common/config/api-config.service';

/**
 * Analytics store for payment telemetry / OLAP showcases (#25–28).
 * Postgres remains the transactional source of truth.
 */
@Injectable()
export class ClickHouseService implements OnModuleInit, OnModuleDestroy {
  private readonly l = new Logger(ClickHouseService.name);
  private client: ClickHouseClient | null = null;

  constructor(private readonly configService: ApiConfigService) { }

  async onModuleInit() {
    try {
      this.client = createClient({
        url: this.configService.get('clickhouse_url'),
        username: this.configService.get('clickhouse_user'),
        password: this.configService.get('clickhouse_password'),
        database: this.configService.get('clickhouse_database'),
      });
      await this.client.ping();
      this.l.log(
        `ClickHouse ready at ${this.configService.get('clickhouse_url')}`,
      );
    } catch (error: any) {
      this.l.warn(`ClickHouse init skipped: ${error?.message ?? error}`);
      this.client = null;
    }
  }

  async onModuleDestroy() {
    await this.client?.close();
  }

  public getClient(): ClickHouseClient {
    if (!this.client) {
      throw new Error('ClickHouse client is not initialized');
    }
    return this.client;
  }

  /**
   * Escape hatch for showcase queries (funnels, uniq, ASOF, MVs).
   * // See README.md#adr -> "Why use ClickHouse for analytics?", "Why use the windowFunnel function...", and "Why use HyperLogLog..."
   */
  public async query<T extends Record<string, unknown>>(
    sql: string,
    query_params?: Record<string, unknown>,
  ): Promise<T[]> {
    const result = await this.getClient().query({
      query: sql,
      query_params,
      format: 'JSONEachRow',
    });
    return result.json<T>();
  }
}
