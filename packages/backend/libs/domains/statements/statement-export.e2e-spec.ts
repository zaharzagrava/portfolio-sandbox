import http from 'node:http';
import type { AddressInfo } from 'node:net';
import v8 from 'node:v8';
import vm from 'node:vm';
import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import type { TestUser } from '@app/test/utils/catalog-app';
import { DS1, orderPaid } from '@app/test/fixtures/statements';
import { StatementsLifecycle } from './infra/statements-lifecycle';
import { STATEMENTS_CONFIG, type StatementsConfig } from './domain/config';
import { EXPORT_SOURCE, type ExportSource } from './domain/ports';
import { CSV_HEADER } from './domain/csv';
import {
  createStatementsApp,
  type StatementsTestApp,
} from './testing/statements-app';
import {
  closeMonth,
  createShops,
  rc1,
  readStatement,
  seedDs1,
  setClock,
  setRate,
  type Shops,
} from './testing/statements-flows';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A garbage collection the spec can trigger without `--expose-gc`, so heap numbers measure what is retained. */
function collector(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

/** RFC 4180: quoted cells with doubled quotes, rows ended by CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('Statements: streamed CSV export', () => {
  let t: StatementsTestApp;
  let shops: Shops;
  let config: StatementsConfig;

  beforeAll(async () => {
    t = await createStatementsApp();
    config = t.app.get(STATEMENTS_CONFIG, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
    config.exportBatch = 1000;
    config.exportTimeoutMs = 120_000;
    setClock(t, '2026-04-01T00:30:00Z');
    shops = await createShops(t);
  });

  const owner = (shopId: string) => t.member(shopId, 'OWNER');
  const csv = async (
    shopId: string,
    month: string,
    query = '',
    who?: TestUser,
  ) => {
    const user = who ?? (await owner(shopId));
    return t
      .as(user)
      .get(`/api/shops/${shopId}/statements/${month}/lines.csv${query}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => cb(null, data));
      });
  };
  const text = (res: { body: unknown }) => String(res.body);
  const tableCounts = async () =>
    (
      await t.sql<{ n: string }>(
        `SELECT ((SELECT count(*) FROM "StatementSaleFact") + (SELECT count(*) FROM "StatementSnapshot") + (SELECT count(*) FROM "StatementAdjustment")
               + (SELECT count(*) FROM "Job") + (SELECT count(*) FROM "Outbox") + (SELECT count(*) FROM "CommissionRate"))::text AS n`,
      )
    )[0].n;
  const sums = (rows: string[][]) =>
    rows.slice(1).reduce(
      (acc, r) => ({
        gross: acc.gross + Number(r[8] || 0),
        commission: acc.commission + Number(r[10] || 0),
      }),
      { gross: 0, commission: 0 },
    );
  const closeDs1 = async () => {
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
  };
  /** Privileged volume setup: n sale lines of one shop in March (the consumers are covered by the specs above). */
  const bulkFacts = (shopId: string, n: number) =>
    t.sequelize.query(
      `INSERT INTO "StatementSaleFact" ("orderId","lineId","orderVersion","shopId","productId","category","quantity","unitPriceMinor",
                                        "discountMinor","lineTotalMinor","paidAt","recordedAt","appliedAt","eventId")
       SELECT gen_random_uuid(), 'line-' || i, 1, :shopId, 'p' || i, 'books', 1, 1000, 0, 1000,
              timestamptz '2026-03-05 10:00:00+00' + (i || ' seconds')::interval, timestamptz '2026-03-05 10:00:00+00',
              timestamptz '2026-03-05 10:00:00+00', gen_random_uuid()
         FROM generate_series(1, :n) AS i`,
      { replacements: { shopId, n } },
    );

  it('S16 AS-61: the CSV of a closed month has the documented headers, first line and rows, and equals the statement', async () => {
    await closeDs1();
    const before = await tableCounts();
    const res = await csv(shops.a, '2026-03');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="statement-${shops.a}-2026-03.csv"`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = text(res);
    expect(body.startsWith(CSV_HEADER)).toBe(true);
    expect(body.split('\r\n')[0]).toBe(
      'rowType,orderId,lineId,paidAt,productId,category,quantity,unitPriceMinor,lineTotalMinor,rateBps,commissionMinor,refersToMonth,bookedMonth,cause',
    );
    const rows = parseCsv(body);
    expect(rows).toHaveLength(4);
    expect(
      rows.slice(1).map((r) => [r[0], r[1], r[2], r[8], r[9], r[10]]),
    ).toEqual([
      ['sale', DS1.o1, DS1.l1, '10000', '1000', '1000'],
      ['sale', DS1.o2, DS1.l2, '20000', '1000', '2000'],
      ['sale', DS1.o3, DS1.l3, '500', '1000', '50'],
    ]);
    const statement = await readStatement(t, shops.a, '2026-03');
    expect(sums(rows)).toEqual({
      gross: statement.total.grossMinor,
      commission: statement.total.commissionMinor,
    });
    expect(await tableCounts()).toBe(before);
  });

  it('S16 AS-62: a closed month downloads the same bytes after a later rate change; the correction is in the April file', async () => {
    await closeDs1();
    const first = text(await csv(shops.a, '2026-03'));
    const change = await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    setClock(t, '2026-04-20T10:00:00Z');
    expect(text(await csv(shops.a, '2026-03'))).toBe(first);

    const april = parseCsv(text(await csv(shops.a, '2026-04')));
    expect(april).toHaveLength(2);
    expect(april[1]).toEqual([
      'adjustment',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '0',
      '',
      '-900',
      '2026-03',
      '2026-04',
      `rate_change:${change.changeId}`,
    ]);
    const statement = await readStatement(t, shops.a, '2026-04');
    expect(sums(april)).toEqual({
      gross: statement.total.grossMinor,
      commission: statement.total.commissionMinor,
    });
  });

  it('S16 AS-63: knownAt prices the lines as known then, adds no adjustment rows, and validates like the statement', async () => {
    await closeDs1();
    await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    setClock(t, '2026-04-20T10:00:00Z');
    const rows = parseCsv(
      text(await csv(shops.a, '2026-03', '?knownAt=2026-04-06T00:00:00Z')),
    );
    expect(rows.slice(1).map((r) => r[0])).toEqual(['sale', 'sale', 'sale']);
    const electronics = rows.slice(1).filter((r) => r[5] === 'electronics');
    expect(electronics.map((r) => r[9])).toEqual(['700', '700']);
    const statement = await readStatement(
      t,
      shops.a,
      '2026-03',
      '?knownAt=2026-04-06T00:00:00Z',
    );
    expect(sums(rows)).toEqual({
      gross: statement.own.grossMinor,
      commission: statement.own.commissionMinor,
    });

    expect((await csv(shops.a, '2026-03', '?knownAt=yesterday')).status).toBe(
      400,
    );
    const future = await csv(
      shops.a,
      '2026-03',
      '?knownAt=2030-01-01T00:00:00Z',
    );
    expect(future.status).toBe(422);
  });

  it('S16 AS-64: text cells are formula-safe and the negative adjustment stays a bare number', async () => {
    const evil = ['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)'];
    await t.sales.deliver(
      ...evil.map((category) =>
        orderPaid({
          paidAt: '2026-03-10T10:00:00Z',
          lines: [{ shopId: shops.a, unitPriceMinor: 1000, category }],
        }),
      ),
    );
    const body = text(await csv(shops.a, '2026-03'));
    // categories are stored lower-cased (one comparison rule), then neutralised for the sheet
    expect(body).toContain('"\'=hyperlink(""http://evil"")"');
    expect(body).toContain('"\'+1+1"');
    expect(body).toContain('"\'-2+3"');
    expect(body).toContain('"\'@sum(a1)"');
    const cells = parseCsv(body)
      .slice(1)
      .map((r) => r[5])
      .sort();
    expect(cells).toEqual(evil.map((c) => `'${c.toLowerCase()}`).sort());

    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    await setRate(
      t,
      {
        shopId: shops.a,
        category: '=hyperlink("http://evil")',
        rateBps: 500,
        validFrom: '2026-03-01T00:00:00Z',
        reason: 'neg',
      },
      '2026-04-05T09:00:00Z',
    );
    await t.drainJobs();
    setClock(t, '2026-04-20T10:00:00Z');
    const april = text(await csv(shops.a, '2026-04'));
    expect(april).toMatch(/,-50,/);
    expect(april).not.toContain("'-50");
  });

  it('S16 AS-69: a month without sales is the header line only', async () => {
    const res = await csv(shops.c, '2026-03');
    expect(res.status).toBe(200);
    expect(text(res)).toBe(CSV_HEADER);
  });

  it('S16 AS-70: two lines of one order for the same product are two rows, in the same order on every download', async () => {
    const productId = uuidv4();
    await t.sales.deliver(
      orderPaid({
        orderId: DS1.o1,
        paidAt: '2026-03-10T10:00:00Z',
        lines: [
          { lineId: 'line-2', productId, shopId: shops.a, unitPriceMinor: 700 },
          { lineId: 'line-1', productId, shopId: shops.a, unitPriceMinor: 300 },
        ],
      }),
    );
    const first = text(await csv(shops.a, '2026-03'));
    const second = text(await csv(shops.a, '2026-03'));
    expect(second).toBe(first);
    const rows = parseCsv(first).slice(1);
    expect(rows.map((r) => [r[2], r[4], r[8]])).toEqual([
      ['line-1', productId, '300'],
      ['line-2', productId, '700'],
    ]);
  });

  describe('large exports', () => {
    const open = async (shopId: string, month: string, user: TestUser) => {
      const port = (t.app.getHttpServer().address() as AddressInfo).port;
      return new Promise<http.IncomingMessage>((resolve, reject) => {
        let answered = false;
        http
          .get(
            {
              host: '127.0.0.1',
              port,
              path: `/api/shops/${shopId}/statements/${month}/lines.csv`,
              headers: { Authorization: user.bearer },
            },
            (res) => {
              answered = true;
              resolve(res);
            },
          )
          // once the answer started, an aborted transfer is the result under test, not a failure of the request
          .on('error', (error) => {
            if (!answered) reject(error);
          });
      });
    };
    const restores: (() => void)[] = [];
    afterEach(() => {
      while (restores.length) restores.pop()!();
    });
    /**
     * Counts what the export asks of the database. A plain wrapper, not a jest mock: a mock keeps every return value,
     * which would hold 200,000 rows in memory and fake a leak in the very test that measures memory.
     */
    const batches = () => {
      const source = t.app.get<ExportSource>(EXPORT_SOURCE, { strict: false });
      const fetched = { rows: 0, calls: 0 };
      const original = source.saleBatch;
      const real = original.bind(source);
      source.saleBatch = async (req) => {
        fetched.calls++;
        const rows = await real(req);
        fetched.rows += rows.length;
        return rows;
      };
      restores.push(() => {
        source.saleBatch = original;
      });
      return { fetched, real, source };
    };

    it('S16 AS-65: a slow reader holds back the database; memory stays flat; the whole file still arrives', async () => {
      await bulkFacts(shops.a, 200_000);
      const { fetched } = batches();
      const user = await owner(shops.a);
      // a first full download warms every lazy path (modules, plans, buffers): the measure is the second one
      const warm = await open(shops.a, '2026-03', user);
      await new Promise<void>((resolve) => {
        warm.on('data', () => undefined);
        warm.on('end', resolve);
      });
      fetched.rows = 0;
      fetched.calls = 0;
      const gc = collector();
      gc();
      const heapBefore = process.memoryUsage().heapUsed;
      const res = await open(shops.a, '2026-03', user);
      expect(res.statusCode).toBe(200);
      let newlines = 0;
      let first = true;
      await new Promise<void>((resolve) => {
        res.on('data', (chunk: Buffer) => {
          for (const byte of chunk) if (byte === 10) newlines++;
          if (first) {
            first = false;
            res.pause();
            resolve();
          }
        });
      });
      await sleep(1500); // the client reads nothing: the server must stop asking the database
      const whileStalled = fetched.rows;
      expect(whileStalled).toBeLessThan(120_000);
      expect(fetched.calls).toBeLessThan(120);
      gc();
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(
        50 * 1024 * 1024,
      );
      await new Promise<void>((resolve) => {
        res.on('end', resolve);
        res.resume();
      });
      expect(newlines).toBe(200_001);
      expect(fetched.rows).toBe(200_000);
      gc();
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(
        50 * 1024 * 1024,
      );
    }, 180_000);

    it('S16 AS-66: a client that leaves after the first chunk frees the database and logs no server error', async () => {
      await bulkFacts(shops.a, 60_000);
      const errors = jest.spyOn(Logger.prototype, 'error');
      const { fetched } = batches();
      const user = await owner(shops.a);
      const res = await open(shops.a, '2026-03', user);
      await new Promise<void>((resolve) => res.once('data', () => resolve()));
      res.destroy();
      await sleep(500);
      const afterLeaving = fetched.rows;
      await sleep(1500);
      expect(fetched.rows).toBe(afterLeaving); // no more batches asked for
      expect(fetched.rows).toBeLessThan(60_000);
      const busy = await t.sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE state <> 'idle' AND query ILIKE '%StatementSaleFact%' AND pid <> pg_backend_pid()`,
      );
      expect(busy[0].n).toBe('0');
      expect(errors).not.toHaveBeenCalled();
    }, 120_000);

    it('S16 AS-67: a database failure after the first chunk aborts the response, never a file that looks complete', async () => {
      await bulkFacts(shops.a, 500);
      config.exportBatch = 100;
      const warnings = jest.spyOn(Logger.prototype, 'warn');
      const { real, source } = batches();
      let calls = 0;
      jest.spyOn(source, 'saleBatch').mockImplementation(async (req) => {
        if (++calls === 2) throw new Error('replica connection lost');
        return real(req);
      });
      const before = metric('statements_export_aborted_total', {
        reason: 'db_error',
      });
      const user = await owner(shops.a);
      const res = await open(shops.a, '2026-03', user);
      let completed = false;
      let received = 0;
      await new Promise<void>((resolve) => {
        res.on('data', (c: Buffer) => (received += c.length));
        res.on('end', () => (completed = true));
        res.on('close', resolve);
        res.on('error', () => undefined);
      });
      expect(res.statusCode).toBe(200);
      expect(completed).toBe(false);
      expect(res.complete).toBe(false);
      expect(received).toBeGreaterThanOrEqual(0);
      expect(
        metric('statements_export_aborted_total', { reason: 'db_error' }),
      ).toBe(before + 1);
      const logged = warnings.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('export aborted'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(shops.a);
      expect(logged[0]).not.toMatch(/line-\d+/);
    }, 120_000);

    it('S16 AS-67: a statement that outlives the export timeout aborts the same way with reason timeout', async () => {
      await bulkFacts(shops.a, 500);
      config.exportBatch = 100;
      config.exportTimeoutMs = 1000;
      const { real, source } = batches();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const locker = t.sequelize.transaction(async (tx) => {
        await t.sequelize.query(
          `LOCK TABLE "StatementSaleFact" IN ACCESS EXCLUSIVE MODE`,
          { transaction: tx },
        );
        locked();
        await hold;
      });
      let calls = 0;
      jest.spyOn(source, 'saleBatch').mockImplementation(async (req) => {
        if (++calls === 1) {
          release();
          await locker;
          return real(req);
        }
        if (calls === 2) {
          // the next statement waits on a lock another session holds past the export timeout
          const second = t.sequelize.transaction(async (tx) => {
            await t.sequelize.query(
              `LOCK TABLE "StatementSaleFact" IN ACCESS EXCLUSIVE MODE`,
              { transaction: tx },
            );
            await sleep(4000);
          });
          await sleep(300);
          try {
            return await real(req);
          } finally {
            await second.catch(() => undefined);
          }
        }
        return real(req);
      });
      await lockTaken;
      const before = metric('statements_export_aborted_total', {
        reason: 'timeout',
      });
      const user = await owner(shops.a);
      const res = await open(shops.a, '2026-03', user);
      let completed = false;
      await new Promise<void>((resolve) => {
        res.on('data', () => undefined);
        res.on('end', () => (completed = true));
        res.on('close', resolve);
        res.on('error', () => undefined);
      });
      expect(completed).toBe(false);
      expect(
        metric('statements_export_aborted_total', { reason: 'timeout' }),
      ).toBe(before + 1);
    }, 120_000);

    it('S16 AS-68: a third concurrent export is 429 with Retry-After and takes no database connection', async () => {
      await bulkFacts(shops.a, 300);
      const { source, real } = batches();
      jest.spyOn(source, 'saleBatch').mockImplementation(async (req) => {
        await sleep(1500);
        return real(req);
      });
      const [a, b] = [await owner(shops.a), await owner(shops.a)];
      const slow = [
        csv(shops.a, '2026-03', '', a),
        csv(shops.a, '2026-03', '', b),
      ];
      await sleep(400);
      const calls = (source.saleBatch as jest.Mock).mock.calls.length;
      const third = await csv(shops.a, '2026-03', '', await owner(shops.a));
      expect(third.status).toBe(429);
      expect(third.body.code ?? JSON.parse(text(third)).code).toBe(
        'rate_limited',
      );
      expect(third.headers['retry-after']).toBeDefined();
      expect((source.saleBatch as jest.Mock).mock.calls.length).toBe(calls);
      expect((await Promise.all(slow)).map((r) => r.status)).toEqual([
        200, 200,
      ]);
    }, 120_000);

    it('S16 AS-80: an export still streaming when the service stops finishes inside the drain time or is cut', async () => {
      await bulkFacts(shops.a, 60_000);
      const lifecycle = t.app.get(StatementsLifecycle, { strict: false });
      const user = await owner(shops.a);
      const res = await open(shops.a, '2026-03', user);
      await new Promise<void>((resolve) =>
        res.once('data', () => {
          res.pause();
          resolve();
        }),
      );
      expect(lifecycle.activeExports).toBe(1);
      config.drainMs = 1000;
      const before = metric('statements_export_aborted_total', {
        reason: 'shutdown',
      });
      const drained = lifecycle.drainExports(); // the reader is stalled: the drain time runs out and the export is cut
      await drained;
      let completed = false;
      await new Promise<void>((resolve) => {
        res.on('end', () => (completed = true));
        res.on('close', resolve);
        res.on('error', () => undefined);
        res.resume();
      });
      expect(completed).toBe(false);
      expect(
        metric('statements_export_aborted_total', { reason: 'shutdown' }),
      ).toBe(before + 1);
      expect(lifecycle.activeExports).toBe(0);
      (lifecycle as unknown as { stopping: boolean }).stopping = false;
    }, 120_000);
  });

  // Last in the file: it boots a second app, with the limiter store behind a proxy.
  it('S16 AS-68: with the limiter store down the export is refused with 503 and nothing is streamed', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createStatementsApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
    try {
      await own.reset();
      const { shopId } = await own.shopWithOwner();
      const reader = await own.member(shopId, 'OWNER');
      proxy.mode = 'refuse';
      proxy.sever();
      await sleep(300);
      const res = await own
        .as(reader)
        .get(`/api/shops/${shopId}/statements/2026-03/lines.csv`);
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).not.toContain('text/csv');
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  }, 120_000);
});
