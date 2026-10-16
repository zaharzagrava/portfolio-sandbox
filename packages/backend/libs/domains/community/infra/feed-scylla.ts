import { Inject, Injectable, Logger } from '@nestjs/common';
import { types, type Client } from 'cassandra-driver';
import { feedUnavailable } from '../domain/feed-errors';
import { FEED_SCYLLA_CLIENT } from '../domain/ports';

export interface Statement {
  query: string;
  params: unknown[];
}

export interface Page {
  rows: types.Row[];
  /** Resume token of the next page; `null` when this was the last. */
  next: string | null;
}

const READ_MS = 1_000;
const WRITE_MS = 2_000;

/** An integer as the driver's 64-bit type (bigint columns, counter deltas, explicit write timestamps). */
export const long = (value: number): types.Long => types.Long.fromNumber(value);

/**
 * The only door to ScyllaDB for the follow graph and the feed (S26 SC-010): every call has an explicit timeout, and a
 * timeout, an unavailable node or any driver failure is logged by class (never the query text or parameters) and
 * surfaces as `503 feed_unavailable` with a generic detail. The driver client is injected under `FEED_SCYLLA_CLIENT`,
 * so a spec can put a fault wrapper in front of it without touching any feed code.
 */
@Injectable()
export class FeedScylla {
  private readonly logger = new Logger(FeedScylla.name);

  constructor(@Inject(FEED_SCYLLA_CLIENT) private readonly client: Client) {}

  read(query: string, params: unknown[]): Promise<types.ResultSet> {
    return this.run(READ_MS, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: true,
        readTimeout: READ_MS,
      }),
    );
  }

  /** One page of a scan or a wide partition; `after` is the previous page's `next`. */
  async page(
    query: string,
    params: unknown[],
    size: number,
    after: string | null,
  ): Promise<Page> {
    const result = await this.run(READ_MS * 3, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: true,
        readTimeout: READ_MS * 3,
        fetchSize: size,
        ...(after ? { pageState: after } : {}),
      }),
    );
    return { rows: result.rows, next: result.pageState ?? null };
  }

  /** Every row of a partition that is bounded by design (a buyer's follows). */
  async readAll(
    query: string,
    params: unknown[],
    size = 1_000,
  ): Promise<types.Row[]> {
    const rows: types.Row[] = [];
    let after: string | null = null;
    do {
      const page = await this.page(query, params, size, after);
      rows.push(...page.rows);
      after = page.next;
    } while (after);
    return rows;
  }

  /** An idempotent upsert or delete. */
  write(query: string, params: unknown[]): Promise<types.ResultSet> {
    return this.run(WRITE_MS, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: true,
        readTimeout: WRITE_MS,
      }),
    );
  }

  /** A conditional statement (`IF ...`): whether it applied and the row Scylla answered with. */
  async lwt(
    query: string,
    params: unknown[],
  ): Promise<{ applied: boolean; row: types.Row }> {
    const result = await this.run(WRITE_MS, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: false,
        readTimeout: WRITE_MS,
      }),
    );
    const row = result.first();
    return { applied: row?.get('[applied]') === true, row };
  }

  /** A logged batch across partitions: all statements or none; upserts and deletes only. */
  async batch(statements: Statement[]): Promise<void> {
    await this.run(WRITE_MS, () =>
      this.client.batch(statements as never, {
        prepare: true,
        logged: true,
        isIdempotent: true,
        readTimeout: WRITE_MS,
      }),
    );
  }

  /** A counter update: never retried by the driver. */
  async counter(query: string, params: unknown[]): Promise<void> {
    await this.run(WRITE_MS, () =>
      this.client.execute(query, params as never, {
        prepare: true,
        isIdempotent: false,
        readTimeout: WRITE_MS,
      }),
    );
  }

  private async run<T>(timeoutMs: number, call: () => Promise<T>): Promise<T> {
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
      this.logger.warn(`store call failed cause=${(error as Error).name}`);
      throw feedUnavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
