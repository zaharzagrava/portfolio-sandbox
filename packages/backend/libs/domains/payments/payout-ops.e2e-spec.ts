import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  eventEnvelopeSchema,
  payoutEventSchemas,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TopicRegistry } from '@app/infrastructure/events/topic-registry';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { OWNERSHIP } from '../../../db/ownership';
import { PayoutAuditService } from './application/payout-audit.service';
import { PayoutRunService } from './application/payout-run.service';
import { PayoutJobs } from './infra/payout.jobs';
import { PayoutsModule } from './payouts.module';
import { PayoutsWorkerModule } from './payouts-worker.module';
import {
  assertPayoutBooks,
  createGate,
  createPayoutApp,
  fund,
  payoutRows,
  PERIOD,
  RUN_AT,
  seller,
  tally,
  type PayoutRow,
  type PayoutTestApp,
} from './testing';
import { sql } from './testing/ledger-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const expandMigration = require('../../../migrations/20261015400000-s15-payouts-expand.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const contractMigration = require('../../../migrations/contract/20261015400100-s15-payouts-contract.js');

const PAYMENTS_DIR = __dirname;
const first = { attempt: 1, isLastAttempt: false };
const H = 3_600_000;
const TABLES = [
  'Payout',
  'PayoutHistory',
  'PayoutRun',
  'PayoutDestination',
  'PayoutDestinationHistory',
  'PayoutReserve',
  'PayoutReserveHistory',
  'PayoutAuditDay',
  'PayoutAuditFinding',
];
const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Payouts: audit, events, boundaries, migration and configuration', () => {
  let t: PayoutTestApp;

  beforeAll(async () => {
    t = await createPayoutApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    t.clock.set(RUN_AT);
  });

  /** `count` sellers paid by the real run and the real send, in the order of their payout ids. */
  const paid = async (count: number): Promise<PayoutRow[]> => {
    for (let i = 0; i < count; i += 1) await seller(t, { balance: 20_000 });
    await t.run.run({});
    const rows = await payoutRows(t);
    for (const row of rows) await t.transfers.send(row.id, first);
    return (await payoutRows(t)).sort((a, b) => a.id.localeCompare(b.id));
  };
  const events = (type: string) =>
    sql<{ payload: { payload: Record<string, unknown> } }>(
      t.app,
      `SELECT "payload" FROM "Outbox" WHERE "type" = :type`,
      { type },
    );
  const lastDay = () => t.clock.set(new Date('2026-10-06T10:00:00.000Z'));

  describe('the daily audit', () => {
    it('S15 AS-49: a matching day yields nothing; five seeded differences are each counted and evented once; a second run adds nothing; an outage fails the day without partial output', async () => {
      const rows = await paid(7);
      lastDay();
      const clean = await t.audit.auditDay('2026-10-05');
      expect(clean).toEqual({
        day: '2026-10-05',
        status: 'COMPLETED',
        checked: 7,
        discrepancies: 0,
      });
      expect(await events('payout.discrepancy_detected')).toEqual([]);

      const [amount, currency, destination, missing, reversed, , outage] = rows;
      t.provider.tamper(amount.id, { amount: 1 });
      t.provider.tamper(currency.id, { currency: 'gbp' });
      t.provider.tamper(destination.id, { destination: 'acct_ELSEWHERE001' });
      t.provider.forget(missing.id);
      t.provider.reverse(reversed.id);
      const before = (kind: string) =>
        metric('payout_discrepancy_detected_total', { kind });
      const kinds = [
        'amount',
        'currency',
        'destination',
        'missing_transfer',
        'reversed_at_provider',
      ];
      const counts = Object.fromEntries(kinds.map((k) => [k, before(k)]));

      const found = await t.audit.auditDay('2026-10-05');

      expect(found).toMatchObject({ status: 'COMPLETED', discrepancies: 5 });
      for (const kind of kinds) expect(before(kind)).toBe(counts[kind] + 1);
      const evented = await events('payout.discrepancy_detected');
      expect(evented.map((e) => e.payload.payload.kind).sort()).toEqual(
        [...kinds].sort(),
      );
      expect(
        await sql(t.app, `SELECT * FROM "PayoutAuditFinding"`),
      ).toHaveLength(5);

      expect(await t.audit.auditDay('2026-10-05')).toMatchObject({
        discrepancies: 0,
      });
      expect(await events('payout.discrepancy_detected')).toHaveLength(5);

      // the provider is unreachable on one lookup: the day fails and writes nothing, a later run completes it
      t.provider.tamper(outage.id, { amount: 7 });
      t.provider.nextLookups({ kind: 'unreachable' });
      const failed = await t.audit.auditDay('2026-10-05');
      expect(failed.status).toBe('FAILED');
      expect(await sql(t.app, `SELECT "status" FROM "PayoutAuditDay"`)).toEqual(
        [{ status: 'FAILED' }],
      );
      expect(
        await sql(t.app, `SELECT * FROM "PayoutAuditFinding"`),
      ).toHaveLength(5);
      expect(await events('payout.discrepancy_detected')).toHaveLength(5);
      expect(await t.audit.auditDay('2026-10-05')).toMatchObject({
        status: 'COMPLETED',
        discrepancies: 1,
      });
      expect(await events('payout.discrepancy_detected')).toHaveLength(6);
      // the audit changes no payout and posts nothing
      expect(await payoutRows(t, `"status" <> 'PAID'`)).toEqual([]);
      await assertPayoutBooks(t);
    });

    it('S15 AS-49: an open day cannot be audited', async () => {
      await expect(t.audit.auditDay('2026-10-05')).rejects.toThrow(
        /closed UTC day/,
      );
    });
  });

  describe('events, metrics and logs', () => {
    it('S15 AS-50: every lifecycle event is in the outbox, parses with the shared contract, and carries no destination or secret', async () => {
      const sellers: Array<{ shopId: string }> = [];
      for (let i = 0; i < 5; i += 1)
        sellers.push(await seller(t, { balance: 20_000 }));
      await t.run.run({});
      const byShop = Object.fromEntries(
        (await payoutRows(t)).map((r) => [r.shopId, r]),
      );
      const [a, b, c, d, e] = sellers.map((s) => byShop[s.shopId]);

      await t.transfers.send(a.id, first); // payout.paid
      t.provider.next({ kind: 'reject', code: 'account_closed' });
      await t.transfers.send(b.id, first); // payout.failed
      await t.cancellation.cancel(c.id, 'admin-1', 'stop'); // payout.cancelled
      t.provider.next({ kind: 'timeout' });
      await t.transfers.send(d.id, first);
      t.provider.nextLookups({ kind: 'unreachable' });
      t.clock.advance(25 * H);
      await t.resolver.resolveDue(50); // payout.in_doubt
      t.provider.next({ kind: 'wrong', field: 'amount' });
      await t.transfers.send(e.id, first); // payout.discrepancy_detected

      const rows = await sql<{
        type: string;
        payload: unknown;
        aggregateType: string;
      }>(
        t.app,
        `SELECT "type", "payload", "aggregateType" FROM "Outbox" WHERE "type" LIKE 'payout.%'`,
      );
      const seen = new Set<string>();
      for (const row of rows) {
        const envelope = eventEnvelopeSchema.parse(row.payload);
        const schema =
          payoutEventSchemas[envelope.type as keyof typeof payoutEventSchemas];
        expect(schema).toBeDefined();
        const payload = schema.parse(envelope.payload) as {
          payoutId: string;
          payoutVersion: number;
        };
        expect(envelope.aggregateId).toBe(payload.payoutId);
        expect(envelope.aggregateVersion).toBe(payload.payoutVersion);
        expect(row.aggregateType).toBe('payouts');
        seen.add(envelope.type);
      }
      expect([...seen].sort()).toEqual(Object.keys(payoutEventSchemas).sort());
      expect(JSON.stringify(rows)).not.toMatch(/acct_[A-Za-z0-9]/);
      expect(t.app.get(TopicRegistry).topicFor('payouts')).toBe(
        'payouts.events',
      );
    });

    it('S15 AS-51: each metric moves by the stated amount, labels stay in closed sets, and logs hold no destination, account or provider body', async () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation(
            (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
          );
      const snapshot = () => ({
        created: metric('payout_created_total'),
        skipped: metric('payout_skipped_total', {
          reason: 'destination_missing',
        }),
        paid: metric('payout_transfer_total', { outcome: 'paid' }),
        rejected: metric('payout_transfer_total', { outcome: 'rejected' }),
        transient: metric('payout_transfer_total', { outcome: 'transient' }),
        unknown: metric('payout_transfer_total', { outcome: 'unknown' }),
        mismatch: metric('payout_provider_mismatch_total', { kind: 'amount' }),
        conflict: metric('payout_conflicting_outcome_total'),
        discrepancy: metric('payout_discrepancy_detected_total', {
          kind: 'amount',
        }),
        completed: metric('payout_run_total', { status: 'COMPLETED' }),
        durations:
          MetricsRegistry.histogramValue('payout_run_duration_seconds')
            ?.count ?? 0,
      });
      const before = snapshot();
      for (let i = 0; i < 4; i += 1) await seller(t, { balance: 20_000 });
      await seller(t, { balance: 20_000, destination: null });

      await t.run.run({});
      const [p1, p2, p3, p4] = await payoutRows(t);
      await t.transfers.send(p1.id, first);
      t.provider.next({ kind: 'reject', code: 'account_closed' });
      await t.transfers.send(p2.id, first);
      t.provider.next({ kind: 'transient', status: '503' });
      await t.transfers.send(p3.id, first).catch(() => undefined);
      t.provider.next({ kind: 'wrong', field: 'amount' });
      await t.transfers.send(p4.id, first);
      await t.transfers
        .settle(
          { ...(await payoutRows(t, `"id" = :id`, { id: p2.id }))[0] } as never,
          'provider_success',
          t.transfers.paidEffects('tr_late'),
        )
        .catch(() => undefined);
      t.provider.tamper(p1.id, { amount: 3 });
      lastDay();
      await t.audit.auditDay('2026-10-05');

      const after = snapshot();
      expect(after.created - before.created).toBe(4);
      expect(after.skipped - before.skipped).toBe(1);
      expect(after.paid - before.paid).toBe(1);
      expect(after.rejected - before.rejected).toBe(1);
      expect(after.transient - before.transient).toBe(1);
      expect(after.unknown - before.unknown).toBe(1);
      expect(after.mismatch - before.mismatch).toBe(1);
      expect(after.discrepancy - before.discrepancy).toBe(1);
      expect(after.completed - before.completed).toBe(1);
      expect(after.durations - before.durations).toBe(1);

      for (const [name, label, allowed] of [
        [
          'payout_skipped_total',
          'reason',
          [
            'below_minimum',
            'payouts_disabled',
            'shop_not_active',
            'shop_unknown',
            'destination_missing',
            'destination_cooling',
            'insufficient_balance',
            'ledger_busy',
            'internal_error',
          ],
        ],
        [
          'payout_transfer_total',
          'outcome',
          ['paid', 'rejected', 'transient', 'unknown'],
        ],
        [
          'payout_provider_mismatch_total',
          'kind',
          [
            'amount',
            'currency',
            'destination',
            'missing_transfer',
            'duplicate_transfer',
          ],
        ],
        ['payout_run_total', 'status', ['COMPLETED', 'FAILED']],
      ] as const)
        for (const labels of MetricsRegistry.labelSets(name)) {
          expect(Object.keys(labels)).toEqual([label]);
          expect(allowed as readonly string[]).toContain(labels[label]);
        }
      const text = lines.join('\n');
      expect(text).not.toMatch(/acct_[A-Za-z0-9]/);
      expect(text).not.toContain('tr_fake');
      expect(text).not.toContain('"destination"');
    });
  });

  describe('boundaries', () => {
    it('S15 AS-52: the payout tables have no foreign key, are registered to payments, exist, and the topic is registered', async () => {
      const relations = `ARRAY[${TABLES.map((n) => `'"${n}"'::regclass`).join(',')}]`; // constants of this file
      const fks = await sql<{ conname: string }>(
        t.app,
        `SELECT c.conname FROM pg_constraint c
           WHERE c.contype = 'f' AND (c.conrelid = ANY (${relations}) OR c.confrelid = ANY (${relations}))`,
      );
      expect(fks).toEqual([]);
      for (const table of TABLES) {
        expect(OWNERSHIP[table as keyof typeof OWNERSHIP]).toBe(
          'domain:payments',
        );
        expect(
          (
            await sql<{ present: boolean }>(
              t.app,
              `SELECT to_regclass(:name) IS NOT NULL AS present`,
              { name: `"${table}"` },
            )
          )[0].present,
        ).toBe(true);
      }
    });

    it("S15 AS-52: the table-ownership check reports nothing for payments, and the payout code never opens its own transaction or touches another owner's model", () => {
      const out = execFileSync('pnpm', ['check:table-ownership'], {
        cwd: join(PAYMENTS_DIR, '../../..'),
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      expect(
        out.split(/\n(?=\S)/).find((s) => s.startsWith('payments')) ?? '',
      ).toBe('');

      const sources: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name.endsWith('.ts') && !/\.(e2e-)?spec\.ts$/.test(name))
            sources.push(full);
        }
      };
      walk(PAYMENTS_DIR);
      const payoutFiles = sources.filter(
        (f) => /payout/i.test(f) || /payments-models|payouts-/.test(f),
      );
      expect(payoutFiles.length).toBeGreaterThan(20);
      for (const file of payoutFiles) {
        const text = readFileSync(file, 'utf8');
        expect([file, /sequelize\.transaction\(/.test(text)]).toEqual([
          file,
          false,
        ]);
        expect([file, /S54 T037 audit/.test(text)]).toEqual([file, false]);
        expect([
          file,
          /InjectModel\(Shop|ShopModel|MembershipService|FROM "Shop"|@app\/domains\/orders/.test(
            text,
          ),
        ]).toEqual([file, false]);
      }
    }, 120_000);
  });

  describe('migration of existing data (AS-53)', () => {
    const queryInterface = () => t.sequelize.getQueryInterface();
    const dual = (state: 'DISABLE' | 'ENABLE') =>
      t.sequelize.query(
        `ALTER TABLE "Payout" ${state} TRIGGER payout_dual_write`,
      );

    afterEach(() => dual('ENABLE'));

    it('S15 AS-53: old-shape rows keep working, are copied once, and a second run changes nothing', async () => {
      const column = await sql<{ n: string }>(
        t.app,
        `SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = 'Shop' AND column_name = 'stripeAccountId'`,
      );
      expect(column[0].n).toBe('1');
      const viaAccount = uuidv4();
      const viaShop = (await createShop(t.app, null)).id;
      await sql(
        t.app,
        `UPDATE "Shop" SET "stripeAccountId" = 'acct_FROMSHOPROW01' WHERE "id" = :viaShop`,
        { viaShop },
      );
      await sql(
        t.app,
        `INSERT INTO "ProviderAccount" ("shopId", "provider", "accountId") VALUES (:viaAccount, 'stripe', 'acct_FROMACCOUNT01')`,
        { viaAccount },
      );
      await dual('DISABLE'); // old-shape rows: only the legacy columns are filled
      const legacy = [
        [viaAccount, 'PENDING', 7_000, null, '2026-09-28'],
        [viaAccount, 'PAID', 9_000, 'tr_legacy_1', '2026-09-21'],
        [viaShop, 'FAILED', 4_000, null, '2026-09-21'],
      ] as const;
      for (const [shopId, status, amount, providerRef, periodStart] of legacy)
        await sql(
          t.app,
          `INSERT INTO "Payout" ("shopId", "amount", "periodStart", "status", "providerRef") VALUES (:shopId, :amount, :periodStart, :status, :providerRef)`,
          { shopId, amount, periodStart, status, providerRef },
        );
      await dual('ENABLE');
      await sql(t.app, `DELETE FROM "PayoutHistory"`).catch(() => undefined);

      await expandMigration.up(queryInterface());
      const snapshot = async () => ({
        payouts: await sql(
          t.app,
          `SELECT "shopId", "status", "amount"::text, "amountMinor"::text, "providerRef", "transferRef", "destinationSnapshot", "payoutVersion" FROM "Payout" ORDER BY "periodStart", "shopId", "status"`,
        ),
        destinations: await sql(
          t.app,
          `SELECT "shopId", "providerAccountId", "changedBy" FROM "PayoutDestination" ORDER BY "shopId"`,
        ),
        history: await sql(
          t.app,
          `SELECT "payoutId", "toStatus", "actor", "payoutVersion" FROM "PayoutHistory" ORDER BY "payoutId"`,
        ),
      });
      const once = await snapshot();
      await expandMigration.up(queryInterface());
      expect(await snapshot()).toEqual(once);

      expect(once.payouts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'PAID',
            amount: '9000',
            amountMinor: '9000',
            providerRef: 'tr_legacy_1',
            transferRef: 'tr_legacy_1',
            destinationSnapshot: 'acct_FROMACCOUNT01',
            payoutVersion: 1,
          }),
          expect.objectContaining({
            status: 'FAILED',
            amountMinor: '4000',
            destinationSnapshot: 'acct_FROMSHOPROW01',
          }),
          expect.objectContaining({ status: 'PENDING', amountMinor: '7000' }),
        ]),
      );
      expect(once.destinations).toEqual(
        expect.arrayContaining([
          {
            shopId: viaAccount,
            providerAccountId: 'acct_FROMACCOUNT01',
            changedBy: 'migration',
          },
          {
            shopId: viaShop,
            providerAccountId: 'acct_FROMSHOPROW01',
            changedBy: 'migration',
          },
        ]),
      );
      expect(once.history).toHaveLength(3);
      expect(
        once.history.every(
          (h) => (h as { actor: string }).actor === 'migration',
        ),
      ).toBe(true);

      // an old reader that knows only the legacy columns still works: the database fills the new ones
      await sql(
        t.app,
        `INSERT INTO "Payout" ("shopId", "amount", "periodStart") VALUES (:viaAccount, 5000, '2026-09-14')`,
        { viaAccount },
      );
      expect(
        await sql(
          t.app,
          `SELECT "amountMinor"::text FROM "Payout" WHERE "periodStart" = '2026-09-14'`,
        ),
      ).toEqual([{ amountMinor: '5000' }]);
    });

    it('S15 AS-53: a legacy pending payout, migrated, is sent with the new references and the books stay whole', async () => {
      const shopId = uuidv4();
      t.shops.set(shopId);
      await fund(t, shopId, 7_000);
      await sql(
        t.app,
        `INSERT INTO "ProviderAccount" ("shopId", "provider", "accountId") VALUES (:shopId, 'stripe', 'acct_LEGACYPENDING')`,
        { shopId },
      );
      await dual('DISABLE');
      const [{ id }] = await sql<{ id: string }>(
        t.app,
        `INSERT INTO "Payout" ("shopId", "amount", "periodStart") VALUES (:shopId, 7000, '2026-09-28') RETURNING "id"`,
        { shopId },
      );
      await dual('ENABLE');
      await t.inTx((tx) =>
        t.ledger.postJournal(
          {
            kind: 'PAYOUT',
            reference: `payout:${id}`, // the legacy creation journal
            currency: 'EUR',
            lines: [
              { accountId: `SHOP_${shopId}`, amountMinor: -7_000 },
              { accountId: 'PAYOUT_CLEARING', amountMinor: 7_000 },
            ],
          },
          tx,
        ),
      );
      await expandMigration.up(queryInterface());

      await t.transfers.send(id, first);

      expect((await payoutRows(t, `"id" = :id`, { id }))[0]).toMatchObject({
        status: 'PAID',
        destinationSnapshot: 'acct_LEGACYPENDING',
      });
      expect(t.provider.transferCalls()[0]).toMatchObject({
        amountMinor: 7_000,
        destination: 'acct_LEGACYPENDING',
      });
      await assertPayoutBooks(t);
    });

    it('S15 AS-53: the contract step refuses while the new columns disagree with the old ones, and accepts when they agree', async () => {
      const shopId = uuidv4();
      const check = () =>
        t.sequelize.transaction((transaction) =>
          contractMigration.assertSafe((sqlText: string) =>
            t.sequelize.query(sqlText, { transaction }),
          ),
        );
      await sql(
        t.app,
        `INSERT INTO "Payout" ("shopId", "amount", "periodStart", "status", "providerRef") VALUES (:shopId, 1000, '2026-09-28', 'PAID', 'tr_x')`,
        { shopId },
      );
      await expect(check()).resolves.toBeUndefined();

      await dual('DISABLE');
      await sql(t.app, `UPDATE "Payout" SET "amountMinor" = NULL`);
      await expect(check()).rejects.toThrow(/no amountMinor/);
      await sql(t.app, `UPDATE "Payout" SET "amountMinor" = 999`);
      await expect(check()).rejects.toThrow(/do not add up/);
      await sql(
        t.app,
        `UPDATE "Payout" SET "amountMinor" = 1000, "transferRef" = 'tr_other'`,
      );
      await expect(check()).rejects.toThrow(/providerRef/);
      expect(contractMigration.up).toBeDefined();
    });
  });

  describe('configuration (AS-54)', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
    const boot = () => new ApiConfigService(new ConfigUtilsService()).init();

    it.each([
      [
        'PAYOUT_DEFAULT_RESERVE_BPS',
        'payout_default_reserve_bps',
        ['-1', '5001', 'abc'],
      ],
      ['PAYOUT_MIN_MINOR', 'payout_min_minor', ['0', '-5', 'abc']],
      ['PAYOUT_CAP_MINOR', 'payout_cap_minor', ['0', 'abc']],
      [
        'PAYOUT_DESTINATION_COOLING_HOURS',
        'payout_destination_cooling_hours',
        ['-1', 'abc'],
      ],
      [
        'PAYOUT_PROVIDER_TIMEOUT_MS',
        'payout_provider_timeout_ms',
        ['0', '-1', 'abc'],
      ],
      [
        'PAYOUT_SEND_MAX_ATTEMPTS',
        'payout_send_max_attempts',
        ['0', '11', 'abc'],
      ],
      [
        'PAYOUT_RESOLVER_MAX_RESENDS',
        'payout_resolver_max_resends',
        ['-1', '11', 'abc'],
      ],
      ['PAYOUT_STALE_SENDING_MS', 'payout_stale_sending_ms', ['0', 'abc']],
      [
        'PAYOUT_IN_DOUBT_AFTER_HOURS',
        'payout_in_doubt_after_hours',
        ['0', 'abc'],
      ],
    ])(
      'S15 AS-54: %s outside its range fails startup naming the setting and not the value',
      async (variable, key, bad) => {
        for (const value of bad) {
          process.env[variable] = value;
          const failure = await boot().then(
            () => null,
            (error: Error) => error,
          );
          expect([variable, value, failure?.message ?? '']).toEqual([
            variable,
            value,
            expect.stringContaining(key),
          ]);
        }
      },
    );

    it('S15 AS-54: a short cursor secret fails startup naming the setting, never the secret; the defaults apply when nothing is set', async () => {
      process.env.PAYOUT_CURSOR_SECRET = 'too-short-secret';
      const failure = await boot().then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).toContain('payout_cursor_secret');
      expect(failure?.message).not.toContain('too-short-secret');
      delete process.env.PAYOUT_CURSOR_SECRET;
      Object.assign(process.env, saved);
      for (const variable of [
        'PAYOUT_DEFAULT_RESERVE_BPS',
        'PAYOUT_MIN_MINOR',
        'PAYOUT_CAP_MINOR',
        'PAYOUT_DESTINATION_COOLING_HOURS',
        'PAYOUT_PROVIDER_TIMEOUT_MS',
        'PAYOUT_SEND_MAX_ATTEMPTS',
      ])
        delete process.env[variable];
      const config = new ApiConfigService(new ConfigUtilsService());
      await config.init();
      expect([
        config.get('payout_default_reserve_bps'),
        config.get('payout_min_minor'),
        config.get('payout_cap_minor'),
        config.get('payout_destination_cooling_hours'),
        config.get('payout_provider_timeout_ms'),
        config.get('payout_send_max_attempts'),
      ]).toEqual([1000, 1000, 5_000_000, 48, 10_000, 5]);
    });

    it('S15 AS-54: a cap under the minimum fails startup naming both settings', async () => {
      process.env.PAYOUT_MIN_MINOR = '5000';
      process.env.PAYOUT_CAP_MINOR = '1000';
      const failure = await boot().then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).toMatch(/payout_cap_minor/);
      expect(failure?.message).toMatch(/payout_min_minor/);
    });
  });

  describe('shutdown during a run (AS-55)', () => {
    it('S15 AS-55: a stop signal during a shop lets that shop finish whole, starts no other, and the retry resumes', async () => {
      for (let i = 0; i < 4; i += 1) await seller(t, { balance: 20_000 });
      const stop = new AbortController();
      const original = t.creation.createFor.bind(t.creation);
      let started = 0;
      jest
        .spyOn(t.creation, 'createFor')
        .mockImplementation(async (...args) => {
          started += 1;
          if (started === 2) stop.abort(); // the stop arrives while the second shop is being created
          return original(...args);
        });

      const interrupted = await t.run.run({ signal: stop.signal });

      expect(interrupted).toMatchObject({
        status: 'FAILED',
        failureCode: 'interrupted',
        created: 2,
      });
      expect(started).toBe(2);
      expect(await tally(t)).toEqual({
        payouts: 2,
        journals: 2,
        sendJobs: 2,
        history: 2,
        events: { 'payout.created': 2 },
      });
      expect(
        await sql(t.app, `SELECT "status", "failureCode" FROM "PayoutRun"`),
      ).toEqual([{ status: 'FAILED', failureCode: 'interrupted' }]);

      jest.restoreAllMocks();
      const resumed = await t.run.run({});
      expect(resumed).toMatchObject({
        status: 'COMPLETED',
        created: 2,
        existing: 2,
      });
      await assertPayoutBooks(t);
    });

    it('S15 AS-55: the shutdown registry stops the run between shops', async () => {
      for (let i = 0; i < 3; i += 1) await seller(t, { balance: 20_000 });
      const registry = t.app.get(ShutdownRegistry, { strict: false });
      const task = (
        registry as unknown as {
          tasks: Array<{ name: string; run(): Promise<void> }>;
        }
      ).tasks.find((x) => x.name === 'payouts.run.stop')!;
      expect(task).toBeDefined();
      const gate = createGate();
      const original = t.creation.createFor.bind(t.creation);
      let calls = 0;
      jest
        .spyOn(t.creation, 'createFor')
        .mockImplementation(async (...args) => {
          calls += 1;
          if (calls === 1) await gate.wait();
          return original(...args);
        });
      const running = t.run.run({});
      await gate.reached;

      const stopping = task.run();
      gate.open();
      const result = await running;
      await stopping;

      expect(result).toMatchObject({
        status: 'FAILED',
        failureCode: 'interrupted',
        created: 1,
      });
      expect(calls).toBe(1);
      (
        t.app.get(PayoutRunService, { strict: false }) as unknown as {
          stopRequested: boolean;
        }
      ).stopRequested = false;
    });
  });

  // Last in the file: it boots further apps, and the models are bound to the newest connection.
  it('S15 AS-52: PayoutsModule and PayoutsWorkerModule each compile and start on their own', async () => {
    for (const module of [PayoutsWorkerModule, PayoutsModule]) {
      const ref = await generateTestingModule([module], {
        stores: ['redis', 'dynamo'],
      });
      const app = ref.createNestApplication();
      await app.init();
      try {
        expect(app.get(PayoutRunService, { strict: false })).toBeDefined();
        expect(app.get(PayoutAuditService, { strict: false })).toBeDefined();
        if (module === PayoutsWorkerModule)
          expect(app.get(PayoutJobs, { strict: false })).toBeDefined();
      } finally {
        await app.close();
      }
    }
  }, 120_000);
});
