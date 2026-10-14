import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import {
  RequestLogStore,
  RequestSearch,
  StoredRequest,
  UsageQuery,
} from '../domain/ports';

type Row = {
  request_id: string;
  client_request_id: string;
  shop_id: string;
  key_id: string;
  livemode: number;
  version: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  deprecated: number;
  error_code: string;
  batch_ops: number;
  idempotent_replay: number;
  at_text: string;
};

const COLUMNS = `request_id, client_request_id, shop_id, key_id, livemode, version, method, route, status, duration_ms, deprecated, error_code, batch_ops, idempotent_replay, toString(ts) AS at_text`;
const iso = (ts: string): string => `${ts.replace(' ', 'T')}Z`;
const chTime = (d: Date): string => d.toISOString();

/**
 * The request log in ClickHouse (`api_requests`, 30-day TTL): the only place that writes or reads it. Reads always carry the
 * shop; a record is stored once per `(shop, request id)`, however often it is delivered.
 */
@Injectable()
export class ClickHouseRequestLogStore extends RequestLogStore {
  private readonly sink: ClickHouseSink;

  constructor(private readonly clickhouse: ClickHouseService) {
    super();
    this.sink = new ClickHouseSink(clickhouse);
  }

  /** Inserts the records whose `(shop, request id)` is not stored yet; returns how many were new. */
  async insertNew(
    records: (Omit<StoredRequest, 'at'> & { at: Date })[],
  ): Promise<number> {
    const byKey = new Map(
      records.map((r) => [`${r.shopId}|${r.requestId}`, r]),
    );
    if (byKey.size === 0) return 0;
    const wanted = [...byKey.values()];
    const existing = await this.clickhouse.query<{
      shop_id: string;
      request_id: string;
    }>(
      `SELECT shop_id, request_id FROM api_requests
        WHERE shop_id IN {shops:Array(String)} AND request_id IN {ids:Array(String)}
          AND (shop_id, request_id) IN (SELECT arrayJoin(arrayZip({shops:Array(String)}, {ids:Array(String)})))`,
      {
        shops: wanted.map((r) => r.shopId),
        ids: wanted.map((r) => r.requestId),
      },
    );
    for (const e of existing) byKey.delete(`${e.shop_id}|${e.request_id}`);
    const fresh = [...byKey.values()];
    if (fresh.length === 0) return 0;
    await this.sink.insert(
      'api_requests',
      fresh.map((r) => ({
        request_id: r.requestId,
        client_request_id: r.clientRequestId,
        shop_id: r.shopId,
        key_id: r.keyId,
        livemode: r.livemode ? 1 : 0,
        version: r.version,
        method: r.method,
        route: r.route,
        status: r.status,
        duration_ms: r.durationMs,
        deprecated: r.deprecated ? 1 : 0,
        error_code: r.errorCode,
        batch_ops: r.batchOps,
        idempotent_replay: r.idempotentReplay ? 1 : 0,
        ts: r.at.toISOString().replace('Z', '').replace('T', ' '),
      })),
      // a stable id of the batch: the insert is synchronous and a retried batch adds nothing
      {
        dedupeToken: createHash('sha256')
          .update(
            fresh
              .map((r) => `${r.shopId}|${r.requestId}`)
              .sort()
              .join(','),
          )
          .digest('hex'),
      },
    );
    return fresh.length;
  }

  async search(
    shopId: string,
    filter: RequestSearch,
    limit: number,
    after: { at: string; requestId: string } | null,
  ): Promise<StoredRequest[]> {
    const where = [
      'shop_id = {shopId:String}',
      "ts >= parseDateTime64BestEffort({from:String}, 3, 'UTC')",
      "ts <= parseDateTime64BestEffort({to:String}, 3, 'UTC')",
    ];
    const params: Record<string, unknown> = {
      shopId,
      from: chTime(filter.from),
      to: chTime(filter.to),
      limit,
    };
    if (filter.requestId) {
      where.push('request_id = {requestId:String}');
      params.requestId = filter.requestId;
    }
    if (filter.keyId) {
      where.push('key_id = {keyId:String}');
      params.keyId = filter.keyId;
    }
    if (filter.route) {
      where.push('route = {route:String}');
      params.route = filter.route;
    }
    if (filter.livemode !== undefined) {
      where.push('livemode = {livemode:UInt8}');
      params.livemode = filter.livemode ? 1 : 0;
    }
    if (filter.status) {
      where.push('status >= {sMin:UInt16} AND status <= {sMax:UInt16}');
      params.sMin = filter.status.min;
      params.sMax = filter.status.max;
    }
    if (after) {
      where.push(
        "(ts, request_id) < (parseDateTime64BestEffort({cAt:String}, 3, 'UTC'), {cId:String})",
      );
      params.cAt = after.at;
      params.cId = after.requestId;
    }
    const rows = await this.clickhouse.query<Row>(
      `SELECT ${COLUMNS} FROM api_requests WHERE ${where.join(' AND ')}
        ORDER BY ts DESC, request_id DESC LIMIT {limit:UInt32}`,
      params,
    );
    return rows.map((r) => ({
      requestId: r.request_id,
      clientRequestId: r.client_request_id,
      shopId: r.shop_id,
      keyId: r.key_id,
      livemode: r.livemode === 1,
      version: r.version,
      method: r.method,
      route: r.route,
      status: Number(r.status),
      durationMs: Number(r.duration_ms),
      deprecated: r.deprecated === 1,
      errorCode: r.error_code,
      batchOps: Number(r.batch_ops),
      idempotentReplay: r.idempotent_replay === 1,
      at: iso(r.at_text),
    }));
  }

  async usageByDay(shopId: string, q: UsageQuery) {
    return (
      await this.clickhouse.query<{
        day: string;
        version: string;
        route: string;
        calls: string;
        errors: string;
        deprecatedCalls: string;
      }>(
        `SELECT toString(toDate(ts)) AS day, version, route, count() AS calls, countIf(status >= 500) AS errors,
                countIf(deprecated = 1) AS deprecatedCalls
           FROM api_requests
          WHERE shop_id = {shopId:String} AND livemode = {livemode:UInt8}
            AND ts >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
            ${q.deprecatedOnly ? 'AND deprecated = 1' : ''}
          GROUP BY day, version, route ORDER BY day DESC, calls DESC, route ASC`,
        { shopId, livemode: q.livemode ? 1 : 0, from: chTime(q.from) },
      )
    ).map((r) => ({
      day: r.day,
      version: r.version,
      route: r.route,
      calls: Number(r.calls),
      errors: Number(r.errors),
      deprecatedCalls: Number(r.deprecatedCalls),
    }));
  }

  async usageByKey(shopId: string, q: UsageQuery) {
    return (
      await this.clickhouse.query<{
        keyId: string;
        version: string;
        route: string;
        calls: string;
        errors: string;
        lastCallAt: string;
      }>(
        `SELECT key_id AS keyId, version, route, count() AS calls, countIf(status >= 500) AS errors,
                toString(max(ts)) AS lastCallAt
           FROM api_requests
          WHERE shop_id = {shopId:String} AND livemode = {livemode:UInt8}
            AND ts >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
            ${q.deprecatedOnly ? 'AND deprecated = 1' : ''}
          GROUP BY key_id, version, route ORDER BY calls DESC, keyId ASC`,
        { shopId, livemode: q.livemode ? 1 : 0, from: chTime(q.from) },
      )
    ).map((r) => ({
      keyId: r.keyId,
      version: r.version,
      route: r.route,
      calls: Number(r.calls),
      errors: Number(r.errors),
      lastCallAt: iso(r.lastCallAt),
    }));
  }
}
