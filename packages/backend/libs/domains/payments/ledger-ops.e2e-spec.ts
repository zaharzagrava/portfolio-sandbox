import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { context, trace } from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { Role } from '@app/domains/identity';
import { installTestTracing } from '@app/infrastructure/events/testing/test-tracing';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { routeEnvelope } from '@app/infrastructure/projections/routing';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OWNERSHIP } from '../../../db/ownership';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import {
  count,
  newShopAccount,
  orderPaidEvent,
  sql,
} from './testing/ledger-fixtures';
import {
  FakeProviderStatement,
  statementLine,
} from './testing/fake-provider-statement';
import {
  PROVIDER_STATEMENT,
  RECONCILIATION_STORE,
  type ReconciliationStore,
} from './domain/ledger-ports';
import { LedgerProcessingModule } from './ledger-processing.module';
import { LedgerProjectorModule } from './ledger-projector.module';
import { LedgerJobs } from './infra/ledger.jobs';
import { SettlementConsumer } from './infra/settlement.consumer';
import { BalanceProjector } from './infra/balance.projector';
import { ReconciliationRunService } from './application/reconciliation-run.service';
import { STATEMENT_TIMEOUT_MS } from './infra/stripe-statement.adapter';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels);
const DAY = '2026-10-04';
const SENTINEL_EMAIL = 'sentinel-buyer-4d1f@example.test';
const SENTINEL_NOTE = 'SENTINEL-PROVIDER-BODY-77c1';

const PAYMENTS_DIR = __dirname;
const sources = (dir = PAYMENTS_DIR): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory())
      return name === 'testing' ? [] : sources(full);
    return name.endsWith('.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('e2e-spec.ts')
      ? [full]
      : [];
  });
const text = (file: string) => readFileSync(file, 'utf8');

/** The files of the ledger and the reconciliation (everything S14 owns in this domain). */
const LEDGER_FILE =
  /(^|\/)(ledger|journal|balance|reconciliation|settlement|hot-account|invariant|partition|issue-resolution|provider-account|stripe-statement|redis-job|schedule-bootstrap|cursor-secret|payout\.jobs|account|fee|shard|lock-order|run-state|issue-state)/;

describe('Ledger: observability, secrets, configuration and shutdown', () => {
  const fake = new FakeProviderStatement();
  let t: LedgerTestApp;
  let runs: ReconciliationRunService;
  let jobs: LedgerJobs;
  let consumer: SettlementConsumer;
  let projector: BalanceProjector;

  beforeAll(async () => {
    t = await createLedgerApp({
      extraImports: [LedgerProcessingModule, LedgerProjectorModule],
      overrides: [{ provide: PROVIDER_STATEMENT, useValue: fake }],
    });
    runs = t.app.get(ReconciliationRunService, { strict: false });
    jobs = t.app.get(LedgerJobs, { strict: false });
    consumer = t.app.get(SettlementConsumer, { strict: false });
    projector = t.app.get(BalanceProjector, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    fake.reset();
    jest.restoreAllMocks();
  });

  /** Everything the process logs through the Nest logger while `work` runs. */
  const captureLogs = async (work: () => Promise<void>): Promise<string> => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation(
          (...args: unknown[]) => void lines.push(JSON.stringify(args)),
        );
    await work();
    return lines.join('\n');
  };
  const post = (
    lines: { accountId: string; amountMinor: number }[],
    reference = `t-${uuidv4()}`,
  ) =>
    t.inTx((tx) =>
      t.ledger.postJournal(
        { kind: 'ADJUSTMENT', reference, currency: 'EUR', lines },
        tx,
      ),
    );
  const capture = (over: Record<string, unknown> = {}) => {
    const input = {
      paymentId: uuidv4(),
      orderId: uuidv4(),
      paymentRef: `pi_${uuidv4().slice(0, 8)}`,
      userId: uuidv4(),
      amountMinor: 250,
      currency: 'EUR',
      ...over,
    };
    return {
      input,
      done: t.inTx((tx) => t.ledger.recordPaymentCaptured(input, tx)),
    };
  };
  const outbox = async (): Promise<EventEnvelope[]> =>
    (
      await sql<{ payload: EventEnvelope }>(
        t.app,
        `SELECT payload FROM "Outbox" WHERE "type" = 'ledger.journal_posted' ORDER BY "createdAt", id`,
      )
    ).map((r) => r.payload);

  describe('metrics, logs and traces (AS-65)', () => {
    it('S14 AS-65: every instrument of the ledger exists and moves over the posting, projection, settlement, housekeeping and reconciliation flows', async () => {
      const [a, b] = [newShopAccount(), newShopAccount()];
      // AS-01 / AS-02: a posting and a refusal
      await post([
        { accountId: a, amountMinor: -10 },
        { accountId: b, amountMinor: 10 },
      ]);
      await expect(
        post([
          { accountId: a, amountMinor: -10 },
          { accountId: b, amountMinor: 9 },
        ]),
      ).rejects.toBeInstanceOf(Error);
      // AS-22: captures take the shard rows
      const sales = await Promise.all(
        Array.from({ length: 10 }, () => capture().done),
      );
      expect(sales).toHaveLength(10);
      // the commission is taken at settlement: that posting is what touches PLATFORM_FEES
      const settled = capture({ amountMinor: 1000 });
      await settled.done;
      await consumer.project([
        orderPaidEvent({
          orderId: settled.input.orderId,
          shops: [{ shopId: uuidv4(), subtotalMinor: 1000 }],
        }),
      ]);
      // AS-30: the projector: stale and legacy messages
      const events = await outbox();
      await projector.project(events);
      const older = structuredClone(events[0]) as EventEnvelope & {
        payload: {
          lines: { balanceVersion: number; balanceAfterMinor: number }[];
        };
      };
      older.eventId = uuidv4();
      older.payload.lines.forEach((l) => {
        l.balanceVersion = 0;
        l.balanceAfterMinor = 1;
      });
      await projector.project([older]);
      const v1 = {
        ...structuredClone(events[0]),
        eventId: uuidv4(),
        version: 1,
        payload: { kind: 'SALE', lines: [] },
      } as EventEnvelope;
      const routed = routeEnvelope(
        projector.handles,
        v1,
        projector.aggregateIdSchema,
      );
      if (routed.kind === 'handle') await projector.project([routed.envelope]);
      // settlement: skipped (refund first), deferred, dead-lettered
      const paid = capture({ amountMinor: 1050 });
      await paid.done;
      await t.inTx((tx) =>
        t.ledger.recordPaymentRefunded(
          {
            paymentId: paid.input.paymentId,
            refundRef: 're_1',
            amountMinor: 1050,
            currency: 'EUR',
          },
          tx,
        ),
      );
      await consumer.project([
        orderPaidEvent({
          orderId: paid.input.orderId,
          shops: [{ shopId: uuidv4(), subtotalMinor: 1050 }],
        }),
      ]);
      const lonely = orderPaidEvent({
        orderId: uuidv4(),
        shops: [{ shopId: uuidv4(), subtotalMinor: 1000 }],
      });
      await consumer.project([lonely]);
      await expect(
        jobs.settleOrder({ paid: lonely.payload as never, attempt: 6 }),
      ).rejects.toThrow();
      const invalid = orderPaidEvent({ orderId: uuidv4(), shops: [] });
      await expect(consumer.project([invalid])).rejects.toBeInstanceOf(
        PermanentError,
      );
      // housekeeping: a running balance edited by hand
      const yesterday = new Date(
        Math.floor(t.clock.now().getTime() / 86_400_000) * 86_400_000 -
          43_200_000,
      );
      const ours = newShopAccount();
      const keep = t.clock.now();
      t.clock.set(yesterday);
      await post([
        { accountId: ours, amountMinor: -5 },
        { accountId: b, amountMinor: 5 },
      ]);
      t.clock.set(keep);
      await sql(
        t.app,
        `UPDATE "AccountBalance" SET "balanceMinor" = "balanceMinor" + 1 WHERE "accountId" = :a RETURNING 1`,
        { a: ours },
      );
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await jobs.verifyInvariants({});
      // AS-38 / AS-45: reconciliation, completed and failed, with a skipped payout line
      fake.lines = [
        statementLine({ reference: 'pi_missing', amount: 100 }),
        statementLine({ type: 'transfer' }),
      ];
      await runs.runDay(DAY);
      fake.reset();
      fake.failOn(1, 'unavailable');
      await expect(runs.runDay('2026-10-03')).rejects.toThrow();

      const counters: Array<[string, Record<string, string>]> = [
        ['ledger_journals_posted_total', { kind: 'ADJUSTMENT' }],
        ['ledger_journals_posted_total', { kind: 'SALE' }],
        ['ledger_post_rejected_total', { reason: 'journal_unbalanced' }],
        ['ledger_projection_stale_total', {}],
        ['ledger_projection_legacy_skipped_total', {}],
        ['ledger_settlement_deferred_total', {}],
        ['ledger_settlement_skipped_total', { reason: 'refunded' }],
        ['ledger_settlement_dead_lettered_total', { reason: 'sale_not_found' }],
        ['ledger_consumer_dead_lettered_total', { reason: 'invalid_payload' }],
        [
          'ledger_invariant_violations_total',
          { check: 'balance_matches_entries' },
        ],
        ['reconciliation_runs_total', { status: 'completed' }],
        ['reconciliation_runs_total', { status: 'failed' }],
        ['reconciliation_lines_skipped_total', { type: 'transfer' }],
      ];
      for (const [name, labels] of counters)
        expect([
          name,
          JSON.stringify(labels),
          metric(name, labels) ?? 0,
        ]).toEqual([name, JSON.stringify(labels), expect.any(Number)]);
      for (const [name, labels] of counters)
        expect([name, (metric(name, labels) ?? 0) > 0]).toEqual([name, true]);
      expect(
        MetricsRegistry.histogramValue('ledger_lock_wait_seconds', {
          accountClass: 'PLATFORM_FEES',
        })!.count,
      ).toBeGreaterThan(0);
      for (const [name, labels] of [
        ['ledger_balance_projection_lag_seconds', {}],
        ['ledger_default_partition_rows', {}],
        ['reconciliation_issues_open', { kind: 'MISSING_IN_LEDGER' }],
        ['reconciliation_oldest_open_issue_age_seconds', {}],
      ] as Array<[string, Record<string, string>]>)
        expect([name, metric(name, labels) !== undefined]).toEqual([
          name,
          true,
        ]);
      expect(
        metric('reconciliation_issues_open', { kind: 'MISSING_IN_LEDGER' }),
      ).toBe(1);
      // labels stay bounded: no account, shop, journal or run id
      for (const name of [
        'ledger_journals_posted_total',
        'ledger_post_rejected_total',
        'ledger_lock_wait_seconds',
        'reconciliation_runs_total',
      ])
        for (const labels of MetricsRegistry.labelSets(name))
          expect(JSON.stringify(labels)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }, 120_000);

    it('S14 AS-65: log lines name the journal and the run, and the trace of a posting continues in its outbox row', async () => {
      const [a, b] = [newShopAccount(), newShopAccount()];
      let journal = '';
      let runId = '';
      const logs = await captureLogs(async () => {
        journal = (
          await post([
            { accountId: a, amountMinor: -10 },
            { accountId: b, amountMinor: 10 },
          ])
        ).journalId;
        fake.lines = [statementLine({ reference: 'pi_x' })];
        const outcome = await runs.runDay(DAY);
        expect(outcome.outcome).toBe('completed');
        runId = (outcome as { run: { id: string } }).run.id;
      });
      expect(logs).toContain(journal);
      expect(logs).toContain(runId);

      const tracing = installTestTracing();
      try {
        const traceId = await tracing.tracer.startActiveSpan(
          'posting',
          async (span) => {
            try {
              await post([
                { accountId: a, amountMinor: -3 },
                { accountId: b, amountMinor: 3 },
              ]);
              return trace.getSpan(context.active())!.spanContext().traceId;
            } finally {
              span.end();
            }
          },
        );
        const rows = (await outbox()).filter((e) =>
          (e as { traceparent?: string }).traceparent?.includes(traceId),
        );
        expect(rows).toHaveLength(1);
        expect((rows[0] as { traceparent?: string }).traceparent).toMatch(
          new RegExp(`^00-${traceId}-[0-9a-f]{16}-0[01]$`),
        );
      } finally {
        await tracing.shutdown();
      }
    });
  });

  describe('secrets and personal data (AS-66)', () => {
    it('S14 AS-66: the provider secret, the buyer email and raw provider bodies appear in no log, event, outbox row, issue or error body', async () => {
      const secret = t.app
        .get(ApiConfigService)
        .get('stripe_secret_key') as string;
      const buyer = await t.newUser({ email: SENTINEL_EMAIL });
      const bodies: string[] = [];
      const logs = await captureLogs(async () => {
        const sale = capture({ userId: buyer.id, paymentRef: 'pi_secretless' });
        await sale.done;
        fake.lines = [
          statementLine({ id: undefined, note: SENTINEL_NOTE, secret }),
          statementLine({
            reference: 'pi_secretless',
            amount: 250,
            note: SENTINEL_NOTE,
          }),
          statementLine({
            reference: 'pi_other',
            amount: 75,
            note: SENTINEL_NOTE,
          }),
        ];
        await runs.runDay(DAY);
        // an unexpected failure answers generically
        const admin = await t.newUser({ role: Role.ADMIN });
        const issueList = await t
          .as(admin)
          .get('/api/finance/reconciliation/issues');
        bodies.push(JSON.stringify(issueList.body));
        const crash = await t.as(buyer).get('/api/shops/not-a-shop/balance');
        bodies.push(JSON.stringify(crash.body));
      });
      const outboxText = JSON.stringify(
        await sql(t.app, `SELECT "payload" FROM "Outbox"`),
      );
      const issues = JSON.stringify(
        await sql(t.app, `SELECT * FROM "ReconciliationIssue"`),
      );
      const journals = JSON.stringify(
        await sql(t.app, `SELECT * FROM "LedgerJournal"`),
      );
      for (const sentinel of [secret, SENTINEL_EMAIL, SENTINEL_NOTE])
        for (const [where, haystack] of [
          ['logs', logs],
          ['outbox', outboxText],
          ['issues', issues],
          ['journals', journals],
          ['bodies', bodies.join('\n')],
        ] as const)
          expect([where, haystack.includes(sentinel)]).toEqual([where, false]);
    });
  });

  describe('boundaries (AS-67)', () => {
    it('S14 AS-67: ledger and reconciliation code reads no table and imports no model of another owner', () => {
      const files = sources().filter((f) =>
        LEDGER_FILE.test(relative(PAYMENTS_DIR, f)),
      );
      expect(files.length).toBeGreaterThan(30);
      const offences: string[] = [];
      for (const file of files) {
        const body = text(file);
        const rel = relative(PAYMENTS_DIR, file);
        if (/\b(UserModel|BisOrderModel|ShopModel|PaymentModel)\b/.test(body))
          offences.push(`${rel}: foreign model`);
        if (
          /(FROM|JOIN|INTO|UPDATE)\s+"(User|Shop|Payment|BisOrder|Product|ShopMembership)"/i.test(
            body,
          )
        )
          offences.push(`${rel}: foreign table`);
        if (/@(BelongsTo|HasMany|HasOne|BelongsToMany|ForeignKey)\b/.test(body))
          offences.push(`${rel}: association`);
        if (/from '@app\/domains\/(orders|catalog)'/.test(body))
          offences.push(`${rel}: import of orders or catalog`);
        if (
          /from '\.\/(models\/)?payment\.model'|from '\.\.\/infra\/models\/payment\.model'/.test(
            body,
          )
        )
          offences.push(`${rel}: Payment model`);
      }
      expect(offences).toEqual([]);
    });

    it('S14 AS-67: the barrel exports only the "Provides" list and no model; no direct transaction or audit marker is left; the registry owns every new table', () => {
      const barrel = text(join(PAYMENTS_DIR, 'index.ts'));
      const exported = [...barrel.matchAll(/export (?:type )?\{([^}]+)\}/g)]
        .flatMap((m) =>
          m[1].split(',').map((s) =>
            s
              .trim()
              .split(/\s+as\s+/)
              .pop()!,
          ),
        )
        .filter(Boolean)
        .sort();
      expect(exported).toEqual(
        [
          'JournalPosted',
          'LEDGER_ACCOUNTS',
          'LedgerJournalKind',
          'LedgerModule',
          'LedgerProjectorModule',
          'LedgerService',
          'LedgerWorkerModule',
          'PaymentModule',
          'PaymentProcessorModule',
          'PaymentQueryModule',
          'PaymentQueryService',
          'PaymentStatusView',
          'PayoutsModule',
          'PayoutsWorkerModule',
          'CreatePaymentDto',
          'paymentsProjectors',
          'paymentsRatePolicies',
          'shopAccount',
        ].sort(),
      );
      expect(barrel).not.toMatch(/Model\b/);

      const nonSpec = sources();
      expect(
        nonSpec
          .filter((f) => /\bsequelize\.transaction\(/.test(text(f)))
          .map((f) => relative(PAYMENTS_DIR, f)),
      ).toEqual([]);
      expect(
        nonSpec
          .filter((f) => text(f).includes('S54 T037 audit'))
          .map((f) => relative(PAYMENTS_DIR, f)),
      ).toEqual([]);

      for (const table of [
        'LedgerJournal',
        'AccountBalance',
        'LedgerCheckpoint',
        'LedgerBackfillCursor',
        'ReconciliationIssueHistory',
        'ReconciliationStaging',
        'ReconciliationSeen',
        'ProviderAccount',
        'LedgerEntry',
        'ReconciliationRun',
        'ReconciliationIssue',
      ])
        expect([table, (OWNERSHIP as Record<string, string>)[table]]).toEqual([
          table,
          'domain:payments',
        ]);
    });

    it('S14 AS-67: the table-ownership check reports nothing for the ledger and reconciliation files', () => {
      const out = execFileSync('pnpm', ['check:table-ownership'], {
        cwd: join(PAYMENTS_DIR, '../../..'),
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      const section = out
        .split(/\n(?=\S)/)
        .find((s) => s.startsWith('payments'));
      expect(section ?? '').toBe('');
    }, 120_000);
  });

  describe('configuration (AS-68)', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
    const boot = () => new ApiConfigService(new ConfigUtilsService()).init();

    it.each([
      ['LEDGER_SHARDS', 'ledger_shards', ['0', '257', 'abc']],
      ['LEDGER_LOCK_TIMEOUT_MS', 'ledger_lock_timeout_ms', ['0', '-1', 'abc']],
      [
        'LEDGER_STATEMENT_TIMEOUT_MS',
        'ledger_statement_timeout_ms',
        ['0', '-1', 'abc'],
      ],
      [
        'RECONCILIATION_PAGE_SIZE',
        'reconciliation_page_size',
        ['0', '101', 'abc'],
      ],
      [
        'RECONCILIATION_CATCHUP_DAYS',
        'reconciliation_catchup_days',
        ['0', '31', 'abc'],
      ],
    ])(
      'S14 AS-68: %s outside its range fails startup naming the setting and not the value',
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

    it('S14 AS-68: a missing provider key and a short cursor secret fail startup naming the setting', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      await expect(boot()).rejects.toThrow(/stripe_secret_key/);
      Object.assign(process.env, saved);
      process.env.LEDGER_CURSOR_SECRET = 'too-short';
      await expect(boot()).rejects.toThrow(/ledger_cursor_secret/);
    });

    it('S14 AS-68: the defaults apply when nothing is set', async () => {
      for (const variable of [
        'LEDGER_SHARDS',
        'LEDGER_LOCK_TIMEOUT_MS',
        'LEDGER_STATEMENT_TIMEOUT_MS',
        'RECONCILIATION_PAGE_SIZE',
        'RECONCILIATION_CATCHUP_DAYS',
      ])
        delete process.env[variable];
      const config = new ApiConfigService(new ConfigUtilsService());
      await config.init();
      expect([
        config.get('ledger_shards'),
        config.get('ledger_lock_timeout_ms'),
        config.get('ledger_statement_timeout_ms'),
        config.get('reconciliation_page_size'),
        config.get('reconciliation_catchup_days'),
      ]).toEqual([32, 2_000, 5_000, 100, 7]);
    });
  });

  describe('shutdown and timeouts (AS-69)', () => {
    it('S14 AS-69: every statement and provider call carries a bound', async () => {
      const config = t.app.get(ApiConfigService);
      expect(config.get('ledger_lock_timeout_ms')).toBe(2_000);
      expect(config.get('ledger_statement_timeout_ms')).toBe(5_000);
      expect(STATEMENT_TIMEOUT_MS).toBe(10_000);
      // the posting sets both limits for the transaction it joins
      const seen: string[] = [];
      const original = t.sequelize.query.bind(t.sequelize);
      jest.spyOn(t.sequelize, 'query').mockImplementation(((
        sqlText: unknown,
        options: unknown,
      ) => {
        if (
          typeof sqlText === 'string' &&
          /set_config\('lock_timeout'/.test(sqlText)
        )
          seen.push(String((options as { bind?: unknown[] }).bind));
        return original(sqlText as never, options as never);
      }) as never);
      await post([
        { accountId: newShopAccount(), amountMinor: -1 },
        { accountId: newShopAccount(), amountMinor: 1 },
      ]);
      expect(seen).toEqual(['2000ms,5000ms']);
    });
  });

  // Last in the file: it boots a second app, and the models are bound to the newest connection.
  it('S14 AS-69: on the stop signal the reconciliation asks for no further page, fails the run as interrupted and the next attempt completes the day; the settlement consumer finishes its message', async () => {
    const registry = new ShutdownRegistry();
    const own = await createLedgerApp({
      extraImports: [LedgerProcessingModule],
      overrides: [
        { provide: PROVIDER_STATEMENT, useValue: fake },
        { provide: ShutdownRegistry, useValue: registry },
      ],
    });
    try {
      await own.reset();
      expect(registry.listTaskNames()).toEqual(
        expect.arrayContaining([
          'ledger.reconciliation-runner',
          'ledger.settlement-consumer',
        ]),
      );
      const service = own.app.get(ReconciliationRunService, { strict: false });
      fake.reset();
      fake.lines = Array.from({ length: 450 }, (_, i) =>
        statementLine({ id: `txn_${i}`, reference: `pi_s_${i}`, amount: 100 }),
      );
      let stop: Promise<unknown> | undefined;
      fake.beforePage = (page) => {
        if (page === 2) stop = registry.run('stop');
      };
      const outcome = await service.runDay(DAY);
      await stop;
      expect(outcome.outcome).toBe('interrupted');
      expect(fake.calls.filter((c) => c.op === 'list')).toHaveLength(2); // no page after the signal
      expect(
        (
          await sql<{ status: string; failureCode: string }>(
            own.app,
            `SELECT status, "failureCode" FROM "ReconciliationRun" WHERE day = :d`,
            { d: DAY },
          )
        )[0],
      ).toEqual({ status: 'FAILED', failureCode: 'interrupted' });
      expect(await count(own.app, 'ReconciliationIssue')).toBe(0);
      // the interrupted run is restartable: the next attempt (a new process) claims the day again
      const claim = await own.app
        .get<ReconciliationStore>(RECONCILIATION_STORE, { strict: false })
        .claim({
          provider: 'stripe',
          day: DAY,
          now: own.clock.now(),
          leaseUntil: new Date(own.clock.now().getTime() + 600_000),
        });
      expect(claim.kind).toBe('claimed');

      // a message that arrives after the signal is left to the next consumer
      const consumer2 = own.app.get(SettlementConsumer, { strict: false });
      await expect(
        consumer2.project([
          orderPaidEvent({
            orderId: uuidv4(),
            shops: [{ shopId: uuidv4(), subtotalMinor: 1 }],
          }),
        ]),
      ).rejects.toThrow(/stopping/);
    } finally {
      await own.close();
    }
  }, 60_000);
});
