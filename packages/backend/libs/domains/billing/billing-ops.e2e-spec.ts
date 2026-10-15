import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Sequelize } from 'sequelize';
import { OWNERSHIP } from '../../../db/ownership';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { TestUser } from '@app/test/utils/catalog-app';
import * as barrel from './index';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  createFs,
  expectStatus,
  key,
  subscribeShop,
  type Fixture,
} from './testing/billing-flows';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const original = require('../../../migrations/20261001190000-subscriptions-billing.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const expand = require('../../../migrations/20261016000300-billing-s17-expand.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const attemptRef = require('../../../migrations/20261016000310-billing-s17-attempt-ref.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const contract = require('../../../migrations/20261016000400-billing-s17-contract.js');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'testing' ? [] : sources(path);
    return /\.ts$/.test(name) && !/(\.spec|\.e2e-spec)\.ts$/.test(name)
      ? [path]
      : [];
  });

describe('Billing: boundaries, secrets, migration and shutdown', () => {
  let t: BillingTestApp;

  beforeAll(async () => {
    t = await createBillingApp({ structuredLogger: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date('2026-04-01T00:00:00.000Z'));
  });

  const rows = <T = Record<string, any>>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => t.sql<T>(sql, replacements);
  const sub = async (id: string) =>
    (await rows(`SELECT * FROM "Subscription" WHERE id = :id`, { id }))[0];

  it('S17 AS-82: every table is registered to billing, only billing tables are queried, the barrel exports no model', async () => {
    for (const table of [
      'Plan',
      'Price',
      'Subscription',
      'Invoice',
      'InvoiceLine',
      'SubscriptionTransition',
      'InvoiceTransition',
      'SubjectPlanState',
    ])
      expect((OWNERSHIP as Record<string, string>)[table]).toBe(
        'domain:billing',
      );

    // the tables the domain's own SQL names (never another domain's)
    const own = new Set(
      Object.entries(OWNERSHIP)
        .filter(([, o]) => o === 'domain:billing')
        .map(([name]) => name),
    );
    const technical = new Set([
      'Outbox',
      'Job',
      'JobKey',
      'JobSchedule',
      'ProcessedWebhookEvent',
      'IdempotencyKey',
    ]);
    const foreign: string[] = [];
    for (const file of sources(resolve(__dirname))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /\b(?:FROM|JOIN|INTO|UPDATE)\s+"([A-Za-z]+)"/g,
      )) {
        if (!own.has(match[1]) && !technical.has(match[1]))
          foreign.push(`${file}: ${match[1]}`);
      }
    }
    expect(foreign).toEqual([]);

    // no model in the barrel; apps import only the module entry points
    expect(Object.keys(barrel).filter((name) => /Model$/.test(name))).toEqual(
      [],
    );
    for (const name of [
      'BillingModule',
      'BillingWorkerModule',
      'BillingConsumerModule',
      'SubscriptionBasisService',
      'EntitlementsService',
      'RequiresShopEntitlement',
    ]) {
      expect(Object.keys(barrel)).toContain(name);
    }
    // S18 AS-56: usage enters only by events; no function of the barrel writes it, and no projector class leaves
    for (const name of ['UsageService', 'UsageProjector'])
      expect(Object.keys(barrel)).not.toContain(name);
    const appFiles = [
      'core/src/core.module.ts',
      'worker/src/worker.module.ts',
      'projector/src/projector.module.ts',
    ].map((p) => readFileSync(resolve(__dirname, '../../../apps', p), 'utf8'));
    for (const text of appFiles)
      expect(text).not.toMatch(/@app\/domains\/billing\//);
    // billing reaches shops only through tenancy's exported services
    const code = sources(resolve(__dirname))
      .map((f) =>
        readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, ''),
      )
      .join('\n');
    expect(code).not.toMatch(
      /\b(ShopModel|ShopMembershipModel|MembershipService)\b/,
    );
    expect(code).not.toMatch(/sequelize\.transaction\(/);
  });

  it('S18 AS-56: the ledger table is billing’s, the barrel exports only contracted items, nobody provides billing’s services, the module is not global and the application layer names no store', () => {
    expect((OWNERSHIP as Record<string, string>).UsageSettlement).toBe(
      'domain:billing',
    );

    const exported = Object.keys(barrel).sort();
    // modules, the contracted services and events: no model, projector or consumer class (X.4, D-7, D-8)
    expect(exported).toEqual(
      [
        'BillingConsumerModule',
        'BillingModule',
        'BillingWorkerModule',
        'Domain_EntitlementRequiredError',
        'EntitlementsService',
        'InvoicePaid',
        'InvoicePaymentFailed',
        'RequiresShopEntitlement',
        'SubscriptionBasisService',
        'SubscriptionPlanChanged',
        'SubscriptionStatusChanged',
        'USAGE_LINES_PROVIDER',
        'UsageRecorded',
        'billingRatePolicies',
      ].sort(),
    );
    expect(
      exported.filter((name) => /Consumer$|Projector$|Model$/.test(name)),
    ).toEqual([]);

    // no other domain provides billing's classes itself (D-14): they import the module they use
    const domains = resolve(__dirname, '..');
    const offenders: string[] = [];
    for (const dir of readdirSync(domains)) {
      if (dir === 'billing') continue;
      for (const file of sources(join(domains, dir)).concat(
        readdirSync(join(domains, dir))
          .filter((f) => /\.module\.ts$/.test(f))
          .map((f) => join(domains, dir, f)),
      )) {
        const text = readFileSync(file, 'utf8');
        if (
          /providers:\s*\[[^\]]*\b(EntitlementsService|UsageService|ShopEntitlementGuard|UsageLinesService|UsageSettlementService|UsageReadService)\b/s.test(
            text,
          )
        )
          offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);

    // BillingModule is no longer global
    expect(
      Reflect.getMetadata('__module:global__', barrel.BillingModule),
    ).toBeFalsy();

    // layering (I.2, D-6): S18's application services import no model, queue client, store client or connection
    for (const file of [
      'entitlements.service.ts',
      'entitlement.guard.ts',
      'usage-lines.service.ts',
      'usage-settlement.service.ts',
      'usage-read.service.ts',
      'usage-reconcile.service.ts',
    ]) {
      const text = readFileSync(join(__dirname, 'application', file), 'utf8');
      const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      expect(
        imports.filter((i) =>
          /\/infra\/|sequelize|kafka|clickhouse|\.model$/i.test(i),
        ),
      ).toEqual([]);
    }
  });

  describe('S17 AS-83: no payment data in logs, responses, events or metric labels', () => {
    it('S17 AS-83: across a full lifecycle with pm_ok, pm_declined and pm_timeout', async () => {
      const bodies: string[] = [];
      const record = (res: { body: unknown }) => {
        bodies.push(JSON.stringify(res.body));
        return res;
      };
      const ok = await createFs(t, { plan: 'pro', paymentMethodRef: 'pm_ok' });
      const declined = await createFs(t, { paymentMethodRef: 'pm_declined' });
      const silent = await createFs(t, { paymentMethodRef: 'pm_timeout' });
      for (const fs of [ok, declined, silent]) {
        await t.reauth(fs.owner);
        record(
          await t.as(fs.owner).get(`/api/shops/${fs.shopId}/subscription`),
        );
        record(await t.as(fs.owner).get(`/api/shops/${fs.shopId}/invoices`));
        record(
          await t
            .as(fs.owner)
            .put(`/api/shops/${fs.shopId}/subscription/payment-method`)
            .send({ paymentMethodRef: 'pm_secretcard123' }),
        );
        record(
          await t
            .as(fs.owner)
            .post(`/api/shops/${fs.shopId}/subscription/cancel`)
            .send({}),
        );
        record(
          await t
            .as(fs.owner)
            .post(`/api/shops/${fs.shopId}/subscription/resume`)
            .send({}),
        );
      }
      await t.at('2026-04-02T00:00:00.000Z');
      await t.drainJobs();
      await t.at('2026-04-09T00:00:00.000Z');
      await t.drainJobs();
      await t.at('2026-05-01T00:00:00.000Z');
      await t.runBilling();

      const outbox = JSON.stringify(await rows(`SELECT payload FROM "Outbox"`));
      const logs = t.rawLogs();
      const metricLabels = JSON.stringify(
        [
          'billing_renewals_total',
          'billing_charge_attempts_total',
          'billing_renewal_failed_total',
        ].map((n) => MetricsRegistry.value(n)),
      );
      for (const secret of [
        'pm_ok',
        'pm_declined',
        'pm_timeout',
        'pm_secretcard123',
        'pm_late',
      ]) {
        for (const [where, text] of [
          ['response', bodies.join('\n')],
          ['outbox', outbox],
          ['logs', logs],
          ['metrics', metricLabels],
        ] as const)
          expect({ where, found: text.includes(secret) }).toEqual({
            where,
            found: false,
          });
      }
      expect(logs.length).toBeGreaterThan(0);
      // billing log lines carry the id of what they are about
      const billingLines = logs
        .split('\n')
        .filter((line) =>
          /renewal|charge outcome|unclassifiable|did not answer/.test(line),
        );
      for (const line of billingLines)
        expect(line).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }, 120_000);
  });

  describe('S17 AS-84: the expand migration on live data', () => {
    const SCHEMA = 's17_migration_check';

    it('S17 AS-84: converts credit, keys, versions and seeds without losing data; running it again changes nothing', async () => {
      const cfg = t.sequelize.config as unknown as Record<string, any>;
      const own = new Sequelize(cfg.database, cfg.username, cfg.password, {
        host: cfg.host,
        port: cfg.port,
        dialect: 'postgres',
        logging: false,
        pool: { max: 1, min: 1, idle: 600000 },
      });
      const q = (text: string) => own.query(text);
      try {
        await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        await q(`CREATE SCHEMA ${SCHEMA}`);
        await q(`SET search_path TO ${SCHEMA}, public`);
        // the previous release's schema and data
        await original.up(own.getQueryInterface());
        await q(`INSERT INTO "Subscription" ("subjectType","subjectId","priceId","status","quantity","billingAnchorDay","currentPeriodStart","currentPeriodEnd","paymentMethodRef")
                 SELECT 'SHOP', gen_random_uuid(), pr.id, 'ACTIVE', 1, 1, '2026-04-01', '2026-05-01', 'pm_old'
                   FROM "Price" pr JOIN "Plan" p ON p.id = pr."planId" WHERE p.code = 'starter'`);
        await q(`INSERT INTO "Invoice" ("subscriptionId","periodStart","periodEnd","kind","status","total","currency")
                 SELECT id, '2026-04-01', '2026-05-01', 'RENEWAL', 'PAID', 1900, 'EUR' FROM "Subscription"`);
        await q(`INSERT INTO "Invoice" ("subscriptionId","periodStart","periodEnd","kind","status","total","currency")
                 SELECT id, '2026-04-16', '2026-05-01', 'PRORATION', 'OPEN', -4000, 'EUR' FROM "Subscription"`);
        await q(`INSERT INTO "InvoiceLine" ("invoiceId","kind","description","quantity","amount")
                 SELECT id, 'PRORATION_CREDIT', 'old credit', 1, -4000 FROM "Invoice" WHERE kind = 'PRORATION'`);

        const run = async () => {
          await expand.up(own.getQueryInterface());
          await attemptRef.up(own.getQueryInterface());
          await contract.up(own.getQueryInterface());
        };
        const snapshot = async () => {
          const tables = [
            'Plan',
            'Price',
            'Subscription',
            'Invoice',
            'InvoiceLine',
            'InvoiceTransition',
            'SubscriptionTransition',
          ];
          const out: Record<string, unknown> = {};
          for (const table of tables) {
            const [rowsOf] = await own.query(
              `SELECT * FROM "${table}" ORDER BY 1`,
            );
            out[table] = rowsOf;
          }
          return JSON.stringify(out);
        };
        await run();

        const [[subscription]] = (await own.query(
          `SELECT "creditBalanceMinor", "statusSince", "paymentMethodRef" FROM "Subscription"`,
        )) as any;
        expect(String(subscription.creditBalanceMinor)).toBe('4000');
        expect(subscription.paymentMethodRef).toBe('pm_old');
        const [invoicesAfter] = (await own.query(
          `SELECT kind, status, "businessKey", "paidAt" FROM "Invoice" ORDER BY kind`,
        )) as any;
        expect(invoicesAfter.map((i: any) => [i.kind, i.status])).toEqual([
          ['PRORATION', 'PAID'],
          ['RENEWAL', 'PAID'],
        ]);
        expect(invoicesAfter[1].businessKey).toBe(
          'renewal:2026-04-01T00:00:00.000Z',
        );
        expect(invoicesAfter[0].businessKey).toMatch(
          /^proration:[0-9a-f-]{36}$/,
        );
        expect(invoicesAfter[0].paidAt).not.toBeNull();
        const [history] = (await own.query(
          `SELECT "fromStatus","toStatus",reason FROM "InvoiceTransition"`,
        )) as any;
        expect(history).toEqual([
          { fromStatus: 'OPEN', toStatus: 'PAID', reason: 'migrated_credit' },
        ]);
        const [prices] = (await own.query(
          `SELECT "version","trialDays",currency FROM "Price" ORDER BY "version"`,
        )) as any;
        expect(
          prices.every((p: any) => p.trialDays === 0 && p.currency === 'EUR'),
        ).toBe(true);
        const [plans] = (await own.query(
          `SELECT code, entitlements->>'seats' AS seats FROM "Plan" ORDER BY code`,
        )) as any;
        expect(plans.find((p: any) => p.code === 'starter').seats).toBe('5');
        expect(plans.find((p: any) => p.code === 'pro').seats).toBe('25');
        // the previous release's reads still work against the new schema
        const [old] = (await own.query(
          `SELECT s.id, i.total, l.amount FROM "Subscription" s JOIN "Invoice" i ON i."subscriptionId" = s.id LEFT JOIN "InvoiceLine" l ON l."invoiceId" = i.id`,
        )) as any;
        expect(old.length).toBeGreaterThan(0);
        // the store now refuses what the code relies on it to refuse
        await expect(q(`UPDATE "Price" SET "unitAmount" = 1`)).rejects.toThrow(
          /billing_price_immutable/,
        );
        await expect(q(`DELETE FROM "InvoiceLine"`)).rejects.toThrow(
          /billing_invoice_line_immutable/,
        );

        const before = await snapshot();
        await run();
        expect(await snapshot()).toBe(before);
      } finally {
        await q(`RESET search_path`).catch(() => undefined);
        await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(
          () => undefined,
        );
        await own.close();
      }
    }, 120_000);
  });

  describe('S17 AS-85: graceful shutdown', () => {
    it('S17 AS-85: on the stop signal the run finishes its subscription and stops; the rest renew once in the next run', async () => {
      const five: Fixture[] = [];
      for (let i = 0; i < 5; i++)
        five.push(
          await createFs(t, {
            plan: 'pro',
            quantity: 1,
            at: '2026-04-10T12:00:00.000Z',
          }),
        );
      await t.at('2026-05-10T12:00:00.000Z');
      t.fault.afterSubscription = (n) => {
        if (n === 2) t.lifecycle.beginShutdown();
      };
      const summary = await t.renewals.run(() => t.lifecycle.isStopping());
      delete t.fault.afterSubscription;
      expect(summary.examined).toBe(2);
      const versions = await Promise.all(
        five.map(async (fs) => (await sub(fs.subscriptionId)).version),
      );
      expect(versions.filter((v) => v === 1)).toHaveLength(2);
      t.lifecycle['stopping'] = false;
      expect((await t.renewals.run()).invoiced).toBe(3);
      for (const fs of five) {
        expect((await sub(fs.subscriptionId)).version).toBe(1);
        const keys = await rows<{ businessKey: string }>(
          `SELECT "businessKey" FROM "Invoice" WHERE "subscriptionId" = :id`,
          { id: fs.subscriptionId },
        );
        expect(keys).toHaveLength(2);
      }
    });

    it('S17 AS-85: a charge in flight when the signal comes finishes within its limit and records its result', async () => {
      const fs = await createFs(t, { charge: false });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const original = t.provider.createPaymentIntent.bind(t.provider);
      const spy = jest
        .spyOn(t.provider, 'createPaymentIntent')
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return original(...args);
        });
      try {
        const draining = t.drainJobs();
        await inside;
        t.lifecycle.beginShutdown();
        release();
        await draining;
      } finally {
        release();
        spy.mockRestore();
        t.lifecycle['stopping'] = false;
      }
      const [invoice] = await rows<{ status: string; paidAt: Date | null }>(
        `SELECT status, "paidAt" FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: fs.subscriptionId },
      );
      expect(invoice.status).toBe('PAID');
      expect(invoice.paidAt).not.toBeNull();
    });

    it('S17 AS-85: killed before the answer was recorded, the attempt is unknown and the lookup settles it (one provider call)', async () => {
      const fs = await createFs(t, { charge: false });
      const [invoice] = await rows<{ id: string }>(
        `SELECT id FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: fs.subscriptionId },
      );
      // the process died after the provider took the charge and before we wrote it down
      await t.sequelize.query(
        `UPDATE "Invoice" SET attempts = 1, "attemptStartedAt" = :now, "attemptRef" = '1' WHERE id = :id`,
        { replacements: { id: invoice.id, now: t.clock.now() } },
      );
      t.provider.hold(`${invoice.id}:1`, {
        kind: 'subscription_invoice',
        invoiceId: invoice.id,
        attempt: '1',
      });
      await t.at('2026-04-01T00:05:00.000Z');
      await t.charges.chargeInvoice(invoice.id); // redelivered: the claim is stale
      const [flagged] = await rows<{ attemptUnknown: boolean }>(
        `SELECT "attemptUnknown" FROM "Invoice" WHERE id = :id`,
        { id: invoice.id },
      );
      expect(flagged.attemptUnknown).toBe(true);
      await t.at('2026-04-01T00:10:00.000Z');
      await t.drainJobs();
      const [settled] = await rows<{ status: string }>(
        `SELECT status FROM "Invoice" WHERE id = :id`,
        { id: invoice.id },
      );
      expect(settled.status).toBe('PAID');
      expect(t.provider.creates).toHaveLength(0);
    });
  });

  void (null as unknown as TestUser);
  void key;
  void subscribeShop;
  void expectStatus;
});
