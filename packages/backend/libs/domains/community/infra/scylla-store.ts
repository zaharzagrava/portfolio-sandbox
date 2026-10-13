import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Client, types } from 'cassandra-driver';
import { ApiConfigService } from '@app/common/config';
import { serviceUnavailable } from '../domain/discussion-errors';
import { SCYLLA_CLIENT } from '../domain/ports';
import {
  discussionStoreErrorCounter,
  discussionStoreSeconds,
} from '../domain/discussions-metrics';

export interface Statement {
  query: string;
  params: unknown[];
}

type Kind = 'read' | 'write' | 'lwt' | 'batch' | 'counter';

/**
 * The only door to ScyllaDB for discussions (S25 G3, FR-071). Every call has an explicit timeout; a timeout, an
 * unavailable node or any driver failure is logged by class (never the query text or parameters) and surfaces as
 * `503 service_unavailable` with a generic detail (AS-52). The driver client is injected under `SCYLLA_CLIENT`, so a
 * spec can put a fault wrapper in front of it without touching any discussions code.
 */
@Injectable()
export class ScyllaStore {
  private readonly logger = new Logger(ScyllaStore.name);

  constructor(
    @Inject(SCYLLA_CLIENT) private readonly client: Client,
    private readonly config: ApiConfigService,
  ) {}

  private get readMs(): number {
    return this.config.get('discussions_scylla_read_timeout_ms');
  }

  private get writeMs(): number {
    return this.config.get('discussions_scylla_write_timeout_ms');
  }

  async read(
    query: string,
    params: unknown[],
    options: { fetchSize?: number; pageState?: string } = {},
  ): Promise<types.ResultSet> {
    return this.run('read', this.readMs, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: true,
        readTimeout: this.readMs,
        ...options,
      }),
    );
  }

  /** An idempotent upsert or delete. */
  async write(query: string, params: unknown[]): Promise<types.ResultSet> {
    return this.run('write', this.writeMs, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: true,
        readTimeout: this.writeMs,
      }),
    );
  }

  /** A conditional statement (`IF ...`): returns whether it applied and the row Scylla answered with. */
  async lwt(
    query: string,
    params: unknown[],
  ): Promise<{ applied: boolean; row: types.Row }> {
    const result = await this.run('lwt', this.writeMs, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: false,
        readTimeout: this.writeMs,
      }),
    );
    const row = result.first();
    return { applied: row?.get('[applied]') === true, row };
  }

  /** A logged batch across partitions: all statements or none, upserts only. */
  async batch(statements: Statement[]): Promise<void> {
    await this.run('batch', this.writeMs, () =>
      this.client.batch(statements as never, {
        prepare: true,
        logged: true,
        isIdempotent: true,
        readTimeout: this.writeMs,
      }),
    );
  }

  /** A counter update: never retried by the driver. */
  async counter(query: string, params: unknown[]): Promise<void> {
    await this.run('counter', this.writeMs, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: false,
        readTimeout: this.writeMs,
      }),
    );
  }

  private async run<T>(
    kind: Kind,
    timeoutMs: number,
    call: () => Promise<T>,
  ): Promise<T> {
    const started = process.hrtime.bigint();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            timeoutMs + 100,
          );
        }),
      ]);
    } catch (error) {
      discussionStoreErrorCounter.add(1, { kind });
      this.logger.warn(
        `store call failed kind=${kind} cause=${(error as Error).name}`,
      );
      throw serviceUnavailable();
    } finally {
      if (timer) clearTimeout(timer);
      discussionStoreSeconds.record(
        Number(process.hrtime.bigint() - started) / 1e9,
        { kind },
      );
    }
  }
}
