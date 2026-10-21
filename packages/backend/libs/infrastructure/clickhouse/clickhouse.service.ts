import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { ApiConfigService } from '@app/common/config';

/**
 * Analytics store for payment telemetry / OLAP showcases (#25–28).
 * Postgres remains the transactional source of truth.
 */
@Injectable()
export class ClickHouseService implements OnModuleInit, OnModuleDestroy {
  private readonly l = new Logger(ClickHouseService.name);
  private client: ClickHouseClient | null = null;

  /** The connection check, started in the constructor so it overlaps with the rest of the app start-up. */
  private readonly connecting: Promise<void>;

  constructor(private readonly configService: ApiConfigService) {
    this.connecting = this.connect();
  }

  async onModuleInit() {
    await this.connecting;
  }

  private async connect(): Promise<void> {
    try {
      const client = createClient({
        url: this.configService.get('clickhouse_url'),
        username: this.configService.get('clickhouse_user'),
        password: this.configService.get('clickhouse_password'),
        database: this.configService.get('clickhouse_database'),
      });
      await client.ping();
      this.client = client;
      this.l.log(
        `ClickHouse ready at ${this.configService.get('clickhouse_url')}`,
      );
    } catch (error: any) {
      this.l.warn(`ClickHouse init skipped: ${error?.message ?? error}`);
    }
  }

  async onModuleDestroy() {
    await this.connecting;
    await this.client?.close();
  }

  public getClient(): ClickHouseClient {
    if (!this.client) {
      throw new Error('ClickHouse client is not initialized');
    }
    return this.client;
  }

  /**
   * Durable insert: resolves only when the server has stored the rows (`wait_for_async_insert`), rejects on any
   * failure or when `timeoutMs` passes. For callers that must not lose a row (billing usage, S18); fire-and-forget
   * pipelines use the projection sink instead.
   */
  public async insert(
    table: string,
    rows: Record<string, unknown>[],
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      await this.getClient().insert({
        table,
        values: rows,
        format: 'JSONEachRow',
        abort_signal: abort.signal,
        clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
      });
    } catch (error) {
      if (abort.signal.aborted)
        throw new Error(`ClickHouse insert timed out after ${timeoutMs} ms`, {
          cause: error,
        });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Escape hatch for showcase queries (funnels, uniq, ASOF, MVs).
   * // See README.md#adr -> "Why use ClickHouse for analytics?", "Why use the windowFunnel function...", and "Why use HyperLogLog..."
   */
  public async query<T extends Record<string, unknown>>(
    sql: string,
    query_params?: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T[]> {
    const abort = options.timeoutMs ? new AbortController() : undefined;
    const timer = abort
      ? setTimeout(() => abort.abort(), options.timeoutMs)
      : undefined;
    try {
      const result = await this.getClient().query({
        query: sql,
        query_params,
        format: 'JSONEachRow',
        abort_signal: abort?.signal,
      });
      return await result.json<T>();
    } catch (error) {
      if (abort?.signal.aborted)
        throw new Error(
          `ClickHouse query timed out after ${options.timeoutMs} ms`,
          { cause: error },
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
