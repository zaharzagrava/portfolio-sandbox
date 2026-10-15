import { v4 as uuidv4 } from 'uuid';
import {
  accountingPeriodSchema,
  reconciliationFindingPageSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  DS1,
  GOLDEN,
  ds1Journals,
  goldenLatePayout,
  goldenLateSale,
  goldenMessages,
  ledgerJournal,
  type GoldenShop,
} from '@app/test/fixtures/statements';
import expected from '@app/test/fixtures/statements/golden.expected.json';
import { StatementsJobs } from './infra/statements.jobs';
import {
  createStatementsApp,
  type StatementsTestApp,
} from './testing/statements-app';
import {
  adjustmentsOf,
  closeMonth,
  createShops,
  readStatement,
  seedDs1,
  setClock,
  setRate,
  type Shops,
} from './testing/statements-flows';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Statements: reconciliation and golden dataset', () => {
  let t: StatementsTestApp;
  let shops: Shops;
  let jobs: StatementsJobs;

  beforeAll(async () => {
    t = await createStatementsApp();
    jobs = t.app.get(StatementsJobs, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    setClock(t, '2026-04-01T00:30:00Z');
    shops = await createShops(t);
  });

  const findings = (month = '2026-03') =>
    t.sql<{
      kind: string;
      shopId: string | null;
      expected: string;
      actual: string;
      difference: string;
      status: string;
    }>(
      `SELECT kind, "shopId", "expectedMinor"::text AS expected, "actualMinor"::text AS actual, "differenceMinor"::text AS difference, status
         FROM "StatementFinding" WHERE month = :month ORDER BY kind, "shopId"`,
      { month: `${month}-01` },
    );
  const open = async () =>
    (await findings()).filter((f) => f.status === 'OPEN');
  const verify = () => jobs.verifyPeriod({ month: '2026-03' });
  const adminGet = async (url: string) =>
    t.as(await t.admin()).get(`/api${url}`);

  describe('golden dataset', () => {
    const golden = async () => {
      const g = {
        x: (await t.shopWithOwner()).shopId,
        y: (await t.shopWithOwner()).shopId,
        z: (await t.shopWithOwner()).shopId,
      } as Record<GoldenShop, string>;
      setClock(t, GOLDEN.ratesAt);
      await setRate(t, { shopId: g.y, ...GOLDEN.toysRate });
      setClock(t, '2026-04-01T00:30:00Z');
      await t.sales.deliver(...goldenMessages(g));
      await closeMonth(t, '2026-03', GOLDEN.closeAt);
      setClock(t, GOLDEN.lateSaleAt);
      await t.sales.deliver(goldenLateSale(g));
      setClock(t, GOLDEN.latePayoutAt);
      await t.payouts.deliver(goldenLatePayout(g));
      await setRate(t, { shopId: g.x, ...GOLDEN.retroChange }, GOLDEN.changeAt);
      await t.drainJobs();
      setClock(t, '2026-04-20T10:00:00Z');
      return g;
    };
    const snapshotOf = async (g: Record<GoldenShop, string>) => {
      const out: Record<string, unknown> = {};
      for (const key of ['x', 'y', 'z'] as const) {
        const march = await readStatement(t, g[key], '2026-03');
        const april = await readStatement(t, g[key], '2026-04');
        out[key] = {
          own: march.own,
          corrected: march.corrected,
          april: april.total,
        };
      }
      return out;
    };

    it('S16 AS-71: closing and correcting the golden dataset gives the checked-in output to the minor unit', async () => {
      const g = await golden();
      const seen = await snapshotOf(g);
      for (const key of ['x', 'y', 'z'] as const) {
        const want = expected;
        expect(seen[key]).toEqual({
          own: want.snapshots[key],
          corrected: want.corrected[key],
          april: want.aprilTotals[key],
        });
        const booked = await adjustmentsOf(t, g[key]);
        expect(booked).toHaveLength(1);
        expect(booked[0]).toMatchObject({
          causeKind: want.adjustments[key].causeKind,
          bookedMonth: want.adjustments[key].bookedMonth,
          lines: want.adjustments[key].lineCountDelta,
        });
        expect(Number(booked[0].gross)).toBe(
          want.adjustments[key].grossDeltaMinor,
        );
        expect(Number(booked[0].commission)).toBe(
          want.adjustments[key].commissionDeltaMinor,
        );
        expect(Number(booked[0].payouts)).toBe(
          want.adjustments[key].payoutsPaidDeltaMinor,
        );
      }
      expect(await open()).toEqual([]);
    });

    it('S16 AS-59: emptying the fact store and replaying the topics gives the same facts, statements and answers', async () => {
      const g = await golden();
      const before = await snapshotOf(g);
      const asKnown = async () =>
        Promise.all(
          [
            '2026-03-18T00:00:00Z',
            '2026-04-01T12:00:00Z',
            '2026-04-04T00:00:00Z',
            '2026-04-06T00:00:00Z',
          ].map(async (at) =>
            readStatement(t, g.y, '2026-03', `?knownAt=${at}`).then(
              (s) => s.own,
            ),
          ),
        );
      const answers = await asKnown();
      const factRows = () =>
        t.sql<Record<string, unknown>>(
          `SELECT "orderId", "lineId", "orderVersion", "shopId", category, "lineTotalMinor"::text, "paidAt"::text, "recordedAt"::text
             FROM "StatementSaleFact" ORDER BY "orderId", "lineId"`,
        );
      const facts = await factRows();
      const snapshotsBefore = await t.sql(
        `SELECT * FROM "StatementSnapshot" ORDER BY "shopId"`,
      );
      const adjustmentsBefore = await adjustmentsOf(t);
      expect(facts).toHaveLength(13);

      // the rebuild: facts and the consumers' inbox records are emptied (privileged), then the topics are replayed
      await t.sequelize.query(
        `TRUNCATE "StatementSaleFact", "StatementPayoutFact", "StatementLedgerFact", "StatementLedgerCredit", "StatementStreamWatermark"`,
      );
      await t.sequelize.query(
        `DELETE FROM "ProcessedWebhookEvent" WHERE provider LIKE 'statements-%'`,
      );
      expect(await factRows()).toHaveLength(0);
      setClock(t, '2026-04-21T10:00:00Z');
      await t.sales.deliver(...goldenMessages(g), goldenLateSale(g));
      await t.payouts.deliver(goldenLatePayout(g));
      await t.drainJobs();
      setClock(t, '2026-04-21T11:00:00Z');

      expect(await factRows()).toEqual(facts);
      expect(await snapshotOf(g)).toEqual(before);
      expect(await asKnown()).toEqual(answers);
      expect(
        await t.sql(`SELECT * FROM "StatementSnapshot" ORDER BY "shopId"`),
      ).toEqual(snapshotsBefore);
      expect(await adjustmentsOf(t)).toEqual(adjustmentsBefore);
    });
  });

  describe('against the ledger', () => {
    const closeWithJournals = async (journals = ds1Journals(shops)) => {
      await seedDs1(t, shops);
      await t.ledger.deliver(...journals);
      await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    };

    it('S16 AS-72: a month that agrees with the ledger has no finding and reads as clean', async () => {
      await closeWithJournals();
      expect(await findings()).toEqual([]);
      const view = accountingPeriodSchema.parse(
        (await adminGet('/admin/accounting-periods/2026-03')).body,
      );
      expect(view.reconciliation).toBe('clean');
    });

    it('S16 AS-73: differences become one finding each, idempotently, and clear when the books agree', async () => {
      const journals = ds1Journals(shops);
      // shop a's third order was credited 400 instead of 450, and no fee for it: net -50, fees -50
      journals[2] = ledgerJournal({
        orderId: DS1.o3,
        postedAt: '2026-03-20T12:00:00Z',
        lines: [
          ['PAYMENTS_CLEARING', -400],
          [`SHOP_${shops.a}`, 400],
        ],
      });
      await closeWithJournals(journals);
      expect(
        (await open()).map((f) => [
          f.kind,
          f.shopId,
          f.expected,
          f.actual,
          f.difference,
        ]),
      ).toEqual([
        ['fee_mismatch', null, '3451', '3401', '-50'],
        ['net_mismatch', shops.a, '27450', '27400', '-50'],
      ]);
      expect(
        metric('statements_reconciliation_findings_total', {
          kind: 'net_mismatch',
        }),
      ).toBeGreaterThan(0);
      const view = accountingPeriodSchema.parse(
        (await adminGet('/admin/accounting-periods/2026-03')).body,
      );
      expect(view.reconciliation).toBe('findings');

      const snapshotsBefore = await t.sql(
        `SELECT * FROM "StatementSnapshot" ORDER BY "shopId"`,
      );
      await verify();
      await verify();
      expect(await open()).toHaveLength(2); // one finding per kind and shop, however often it runs

      // the ledger catches up: a second journal for the same order brings the books into agreement
      await t.ledger.deliver(
        ledgerJournal({
          orderId: DS1.o3,
          postedAt: '2026-03-21T12:00:00Z',
          lines: [
            ['PAYMENTS_CLEARING', -100],
            [`SHOP_${shops.a}`, 50],
            ['PLATFORM_FEES', 50],
          ],
        }),
      );
      await verify();
      expect(await open()).toEqual([]);
      expect((await findings()).every((f) => f.status === 'CLEARED')).toBe(
        true,
      );
      expect(
        await t.sql(`SELECT * FROM "StatementSnapshot" ORDER BY "shopId"`),
      ).toEqual(snapshotsBefore);
      const clean = accountingPeriodSchema.parse(
        (await adminGet('/admin/accounting-periods/2026-03')).body,
      );
      expect(clean.reconciliation).toBe('clean');
    });

    it('S16 AS-74: a sale without a journal after the grace, and a journal without a sale, are reported once each', async () => {
      const journals = ds1Journals(shops).slice(0, 2); // orders o3 and o5 never reach the ledger
      await closeWithJournals(journals);
      await verify();
      expect(
        (await findings()).some((f) => f.kind === 'missing_in_ledger'),
      ).toBe(false); // inside the 24 h grace

      setClock(t, '2026-04-03T03:00:00Z'); // 25 hours after the close
      await t.ledger.deliver(
        ledgerJournal({
          orderId: uuidv4(),
          postedAt: '2026-03-25T12:00:00Z',
          lines: [
            ['PAYMENTS_CLEARING', -90],
            [`SHOP_${shops.c}`, 80],
            ['PLATFORM_FEES', 10],
          ],
        }),
      );
      await verify();
      await verify();
      const kinds = (await open()).filter(
        (f) =>
          f.kind === 'missing_in_ledger' || f.kind === 'missing_in_statement',
      );
      expect(
        kinds.map((f) => [f.kind, f.shopId, f.expected, f.actual]),
      ).toEqual(
        [
          ['missing_in_ledger', shops.a, '500', '0'],
          ['missing_in_ledger', shops.b, '4005', '0'],
          ['missing_in_statement', null, '0', '1'],
        ].sort(
          (l, r) =>
            String(l[0]).localeCompare(String(r[0])) ||
            String(l[1]).localeCompare(String(r[1])),
        ),
      );
    });

    it('S16 AS-75: a snapshot altered behind the books is found by the daily run and listed, nothing is auto-corrected', async () => {
      await closeWithJournals();
      const before = metric('statements_completeness_violations_total');
      // privileged tamper (test code only): the guard is switched off in one statement batch and back on
      await t.sequelize.query(
        `ALTER TABLE "StatementSnapshot" DISABLE TRIGGER statements_snapshot_guard;
         UPDATE "StatementSnapshot" SET commission = commission + 1000, net = net - 1000 WHERE "shopId" = '${shops.a}';
         ALTER TABLE "StatementSnapshot" ENABLE TRIGGER statements_snapshot_guard;`,
      );
      setClock(t, '2026-04-10T04:00:00Z');
      await jobs.verifyPeriods();
      const found = (await open()).filter(
        (f) => f.kind === 'completeness_violation',
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        shopId: shops.a,
        expected: '3050',
        actual: '4050',
        difference: '1000',
      });
      expect(metric('statements_completeness_violations_total')).toBe(
        before + 1,
      );
      const [row] = await t.sql<{ commission: string }>(
        `SELECT commission::text FROM "StatementSnapshot" WHERE "shopId" = :s`,
        { s: shops.a },
      );
      expect(row.commission).toBe('4050'); // detected, never repaired

      const admin = await t.admin();
      const page = await t
        .as(admin)
        .get('/api/admin/accounting-periods/2026-03/findings?limit=1');
      expect(page.status).toBe(200);
      const parsed = reconciliationFindingPageSchema.parse(page.body);
      expect(parsed.items.map((i) => i.kind)).toContain(
        'completeness_violation',
      );
      expect(
        (
          await t
            .as(admin)
            .get(
              '/api/admin/accounting-periods/2026-03/findings?cursor=abc.def',
            )
        ).body.code,
      ).toBe('invalid_cursor');
      const owner = await t.member(shops.a, 'OWNER');
      expect(
        (
          await t
            .as(owner)
            .get('/api/admin/accounting-periods/2026-03/findings')
        ).status,
      ).toBe(403);
      expect(
        (await t.http().get('/api/admin/accounting-periods/2026-03/findings'))
          .status,
      ).toBe(401);
    });
  });
});
