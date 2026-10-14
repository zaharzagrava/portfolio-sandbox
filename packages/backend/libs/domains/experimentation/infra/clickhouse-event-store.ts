import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { formatStoredTime } from '@marketplace-sandbox/contracts';
import type {
  CollapsedEvent,
  EventStore,
  ResultsCounts,
  ResultsQuery,
} from '../domain/ports';

/** Every read of the store is bounded: ClickHouse stops the query itself and the HTTP call is aborted a little later. */
export const STORE_READ_TIMEOUT_S = 10;

/**
 * A client time more than 10 minutes ahead is replaced by the receive time (FR-005), so an event whose event time is
 * inside the window was received no earlier than the window start minus this margin (research R-2).
 */
const RECEIVE_MARGIN_MS = 10 * 60_000;

/**
 * The first received copy of every event: identity is `event_id` alone, and `argMin` over `(received_at, ts, name)` picks
 * one copy whatever merged or not, whatever day partition a re-clamped copy fell into (S39 FR-010, research R-1). No read
 * of this store touches the raw table without it.
 */
const COLLAPSED = (where: string) => `
  SELECT event_id,
         argMin(name, k) AS name,
         argMin(anonymous_id, k) AS anonymous_id,
         argMin(user_id, k) AS user_id,
         argMin(ts, k) AS ts,
         argMin(props, k) AS props
  FROM (
    SELECT event_id, name, anonymous_id, user_id, ts, props, tuple(received_at, ts, name) AS k
    FROM analytics_event_log
    WHERE ${where}
  )
  GROUP BY event_id`;

/**
 * One statement, one pass: per unit (user or visitor) the first known exposure inside the window, how many known variants
 * it saw, the exposures naming an unknown variant, and the last event of the metric up to the window end. The outer
 * aggregation puts each unit in a bucket: its variant, `#crossover` (several variants), `#unattributable` (a `user`
 * experiment's exposure without a user id) or `#none`. A unit converts when its last metric event is not before its first
 * exposure.
 */
const RESULTS_SQL = `
  SELECT bucket,
         count() AS units,
         countIf(last_metric_ts >= first_ts) AS conversions,
         sum(exposure_events) AS exposure_events,
         sum(unknown_events) AS unknown_events
  FROM (
    SELECT unit_id,
           multiIf(unit_id = '', '#unattributable',
                   n_variants > 1, '#crossover',
                   n_variants = 1, first_variant,
                   '#none') AS bucket,
           first_ts, last_metric_ts, exposure_events, unknown_events
    FROM (
      SELECT unit_id,
             minIf(ts, is_known) AS first_ts,
             argMinIf(variant, ts, is_known) AS first_variant,
             uniqExactIf(variant, is_known) AS n_variants,
             countIf(is_exposure) AS exposure_events,
             countIf(is_exposure AND NOT is_known) AS unknown_events,
             maxIf(ts, is_metric) AS last_metric_ts
      FROM (
        SELECT if({unit:String} = 'user', user_id, anonymous_id) AS unit_id,
               ts,
               props['variant'] AS variant,
               (name = 'exposure' AND props['experiment'] = {key:String}
                 AND ts >= {windowStart:DateTime64(3, 'UTC')} AND ts <= {windowEnd:DateTime64(3, 'UTC')}) AS is_exposure,
               (is_exposure AND has({variants:Array(String)}, props['variant'])) AS is_known,
               (name = {metric:String} AND ts <= {windowEnd:DateTime64(3, 'UTC')}) AS is_metric
        FROM (${COLLAPSED(`event_id IN (
          SELECT event_id FROM analytics_event_log
          WHERE name IN ('exposure', {metric:String}) AND received_at >= {candidateFrom:DateTime64(3, 'UTC')}
        )`)})
        WHERE is_exposure OR is_metric
      )
      GROUP BY unit_id
    )
  )
  GROUP BY bucket`;

interface ResultRow {
  bucket: string;
  units: string;
  conversions: string;
  exposure_events: string;
  unknown_events: string;
}

/**
 * ClickHouse adapter of `EventStore` (S39). Parameterised, read-only, bounded by a server-side execution limit and an
 * abort signal; a failure or a timeout is thrown to the caller, which answers `503` and never shows partial numbers.
 */
@Injectable()
export class ClickHouseEventStore implements EventStore {
  constructor(private readonly clickhouse: ClickHouseService) {}

  async readResults(query: ResultsQuery): Promise<ResultsCounts> {
    const rows = await this.rows<ResultRow>(RESULTS_SQL, {
      unit: query.unit,
      key: query.experimentKey,
      metric: query.metric,
      variants: query.variants,
      windowStart: formatStoredTime(query.windowStart.getTime()),
      windowEnd: formatStoredTime(query.windowEnd.getTime()),
      candidateFrom: formatStoredTime(
        query.windowStart.getTime() - RECEIVE_MARGIN_MS,
      ),
    });
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));
    return {
      variants: query.variants.map((variant) => {
        const row = byBucket.get(variant);
        return {
          variant,
          exposures: Number(row?.units ?? 0),
          conversions: Number(row?.conversions ?? 0),
        };
      }),
      crossoverUnits: Number(byBucket.get('#crossover')?.units ?? 0),
      unattributable: Number(
        byBucket.get('#unattributable')?.exposure_events ?? 0,
      ),
      unknownVariant: rows.reduce(
        (n, row) => n + Number(row.unknown_events),
        0,
      ),
    };
  }

  async readEvents(eventIds: string[]): Promise<CollapsedEvent[]> {
    if (eventIds.length === 0) return [];
    if (eventIds.length > 500)
      throw new Error('readEvents takes at most 500 ids');
    const rows = await this.rows<CollapsedEvent>(
      COLLAPSED('event_id IN {ids:Array(UUID)}'),
      { ids: eventIds },
    );
    return rows;
  }

  async countEvents(): Promise<number> {
    const [row] = await this.rows<{ n: string }>(
      'SELECT uniqExact(event_id) AS n FROM analytics_event_log',
      {},
    );
    return Number(row?.n ?? 0);
  }

  private async rows<T>(
    query: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    const result = await this.clickhouse.getClient().query({
      query,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: { max_execution_time: STORE_READ_TIMEOUT_S },
      abort_signal: AbortSignal.timeout((STORE_READ_TIMEOUT_S + 2) * 1000),
    });
    return result.json<T>();
  }
}
