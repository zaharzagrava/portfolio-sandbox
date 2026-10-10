import { Logger } from '@nestjs/common';
import { QueryTypes, Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { connectAs, ensureProbeRole } from '@app/test/utils/tenancy-roles';
import { ShopTransactionRunner } from './infra/shop-transaction';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

const PROBE = 'tenancy_probe';

describe('Tenant isolation backstop', () => {
  let t: TenancyTestApp;
  let admin: Sequelize;
  let probe: Sequelize;

  const asProbe = <T>(
    settings: Record<string, string>,
    fn: (
      q: <R extends object>(sql: string, bind?: unknown[]) => Promise<R[]>,
      tx: Transaction,
    ) => Promise<T>,
  ) =>
    probe.transaction(async (tx) => {
      for (const [key, value] of Object.entries(settings))
        await probe.query(`SELECT set_config($1, $2, true)`, {
          bind: [key, value],
          transaction: tx,
        });
      return fn(
        (sql, bind) =>
          probe.query(sql, {
            bind,
            transaction: tx,
            type: QueryTypes.SELECT,
          }) as never,
        tx,
      );
    });

  /** Two shops with one row in each protected table, and one user who is a member of both. */
  const seed = async () => {
    const alice = await t.newUser();
    const bob = await t.newUser();
    const both = await t.newUser();
    const a = await createShop(t.app, alice);
    const b = await createShop(t.app, bob);
    await addMember(t.app, a.id, both.id, 'VIEWER');
    await addMember(t.app, b.id, both.id, 'VIEWER');
    await createInvite(t.app, a.id, {
      email: 'a@example.com',
      invitedBy: alice.id,
    });
    await createInvite(t.app, b.id, {
      email: 'b@example.com',
      invitedBy: bob.id,
    });
    for (const shopId of [a.id, b.id])
      await admin.query(
        `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc") VALUES ($1,'https://idp.example.com','c','sealed')`,
        { bind: [shopId] },
      );
    return { alice, bob, both, a, b };
  };

  beforeAll(async () => {
    t = await createTenancyApp();
    admin = t.app.get(Sequelize);
    await ensureProbeRole(admin, { name: PROBE, statementTimeout: '700ms' });
    probe = connectAs(admin, PROBE);
  });
  afterAll(async () => {
    await probe.close();
    await t.close();
  });
  beforeEach(() => t.reset());

  describe('S03 AS-57: row-level security with a role that cannot bypass it', () => {
    it('the probe role is neither a superuser nor able to bypass', async () => {
      const [role] = await probe.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        { type: QueryTypes.SELECT },
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it.each(['ShopMembership', 'ShopInvite', 'ShopSsoConfig'])(
      '%s is visible by shop only; no context, no rows',
      async (table) => {
        const { a, b } = await seed();
        const ids = (rows: Array<{ shopId: string }>) => [
          ...new Set(rows.map((r) => r.shopId)),
        ];
        expect(
          ids(
            await asProbe({ 'app.shop_id': a.id }, (q) =>
              q(`SELECT "shopId" FROM "${table}"`),
            ),
          ),
        ).toEqual([a.id]);
        expect(
          ids(
            await asProbe({ 'app.shop_id': b.id }, (q) =>
              q(`SELECT "shopId" FROM "${table}"`),
            ),
          ),
        ).toEqual([b.id]);
        expect(
          await asProbe({}, (q) => q(`SELECT "shopId" FROM "${table}"`)),
        ).toEqual([]);
        expect(
          await asProbe(
            { 'app.shop_id': '00000000-0000-0000-0000-000000000000' },
            (q) => q(`SELECT 1 FROM "${table}"`),
          ),
        ).toEqual([]);
      },
    );

    it("a user sees their own memberships across shops (read only), and nobody else's rows", async () => {
      const { both, a, b } = await seed();
      const rows = await asProbe({ 'app.user_id': both.id }, (q) =>
        q<{ shopId: string; userId: string }>(
          `SELECT "shopId","userId" FROM "ShopMembership"`,
        ),
      );
      expect(rows.map((r) => r.shopId).sort()).toEqual([a.id, b.id].sort());
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([both.id]));
      // The user context grants nothing on the other protected tables.
      expect(
        await asProbe({ 'app.user_id': both.id }, (q) =>
          q(`SELECT 1 FROM "ShopInvite"`),
        ),
      ).toEqual([]);
      expect(
        await asProbe({ 'app.user_id': both.id }, (q) =>
          q(`SELECT 1 FROM "ShopSsoConfig"`),
        ),
      ).toEqual([]);
    });

    it('WITH CHECK refuses inserts and updates that cross shops, and writes touch nothing outside the shop', async () => {
      const { alice, a, b } = await seed();
      const stranger = await t.newUser();
      const refused = (p: Promise<unknown>) =>
        expect(p).rejects.toThrow(/row-level security/i);

      await refused(
        asProbe({ 'app.shop_id': a.id }, (q) =>
          q(
            `INSERT INTO "ShopMembership" ("shopId","userId","role") VALUES ($1,$2,'VIEWER')`,
            [b.id, stranger.id],
          ),
        ),
      );
      await refused(
        asProbe({ 'app.shop_id': a.id }, (q) =>
          q(
            `UPDATE "ShopMembership" SET "shopId" = $2 WHERE "shopId" = $1 AND "userId" = $3`,
            [a.id, b.id, alice.id],
          ),
        ),
      );
      await refused(
        asProbe({ 'app.shop_id': a.id }, (q) =>
          q(
            `INSERT INTO "ShopInvite" ("shopId","email","role","tokenHash","invitedBy","expiresAt") VALUES ($1,'x@example.com','STAFF','h',$2,now())`,
            [b.id, alice.id],
          ),
        ),
      );
      await refused(
        asProbe({ 'app.shop_id': a.id }, (q) =>
          q(`UPDATE "ShopSsoConfig" SET "shopId" = $2 WHERE "shopId" = $1`, [
            a.id,
            b.id,
          ]),
        ),
      );
      await refused(
        asProbe({ 'app.user_id': alice.id }, (q) =>
          q(
            `INSERT INTO "ShopMembership" ("shopId","userId","role") VALUES ($1,$2,'OWNER')`,
            [b.id, alice.id],
          ),
        ),
      );

      // A forgotten WHERE changes nothing in another shop.
      const deleted = await asProbe({ 'app.shop_id': a.id }, async (q) => {
        await q(`DELETE FROM "ShopMembership"`);
        return q(`SELECT 1 FROM "ShopMembership"`);
      });
      expect(deleted).toEqual([]);
      const [{ n }] = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM "ShopMembership" WHERE "shopId" = :id`,
        {
          type: QueryTypes.SELECT,
          replacements: { id: b.id },
        },
      );
      expect(Number(n)).toBe(2);
    });
  });

  describe('S03 AS-58: the tenant context never outlives its transaction', () => {
    it('on a pool of one, the next transaction starts without a shop, a user or a bypass', async () => {
      const { a } = await seed();
      const inside = await asProbe({ 'app.shop_id': a.id }, (q) =>
        q(`SELECT "shopId" FROM "ShopMembership"`),
      );
      expect(inside.length).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) {
        const [settings] = await asProbe({}, (q) =>
          q<{
            shop: string | null;
            user: string | null;
            bypass: string | null;
          }>(
            `SELECT current_setting('app.shop_id', true) AS shop, current_setting('app.user_id', true) AS "user", current_setting('app.rls_bypass', true) AS bypass`,
          ),
        );
        expect([
          settings.shop ?? '',
          settings.user ?? '',
          settings.bypass ?? '',
        ]).toEqual(['', '', '']);
        expect(
          await asProbe({}, (q) => q(`SELECT 1 FROM "ShopMembership"`)),
        ).toEqual([]);
      }
    });

    it('through the application runner, consecutive transactions on shared connections carry no earlier context', async () => {
      const { a, both } = await seed();
      const runner = t.app.get(ShopTransactionRunner);
      const tx = t.app.get(TransactionRunner);
      const setting = () =>
        tx.run(async () => {
          const [row] = await admin.query<{
            s: string | null;
            u: string | null;
            b: string | null;
          }>(
            `SELECT current_setting('app.shop_id', true) AS s, current_setting('app.user_id', true) AS u, current_setting('app.rls_bypass', true) AS b`,
            { type: QueryTypes.SELECT },
          );
          return [row.s ?? '', row.u ?? '', row.b ?? ''];
        });
      await runner.inShop(a.id, async () => undefined, { userId: both.id });
      await runner.crossTenant('membership.mine', async () => undefined);
      for (let i = 0; i < 10; i++)
        expect(await setting()).toEqual(['', '', '']);
    });
  });

  describe('S03 AS-59: the bypass is an allowlist with a counter and a log line', () => {
    it('rejects a reason outside the allowlist before any query, and counts the allowed ones by reason', async () => {
      const runner = t.app.get(ShopTransactionRunner);
      const fn = jest.fn(async () => 'ran');
      await expect(
        runner.crossTenant('because.i.say.so' as never, fn),
      ).rejects.toThrow(/not allowed/);
      expect(fn).not.toHaveBeenCalled();
      expect(
        MetricsRegistry.value('tenancy_cross_tenant_total', {
          reason: 'because.i.say.so',
        }),
      ).toBeUndefined();

      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const before =
        MetricsRegistry.value('tenancy_cross_tenant_total', {
          reason: 'invite.accept',
        }) ?? 0;
      const inside = await runner.crossTenant('invite.accept', async () => {
        const [row] = await admin.query<{ bypass: string; reason: string }>(
          `SELECT current_setting('app.rls_bypass', true) AS bypass, current_setting('app.rls_bypass_reason', true) AS reason`,
          { type: QueryTypes.SELECT },
        );
        return row;
      });
      expect(inside).toEqual({ bypass: 'on', reason: 'invite.accept' });
      expect(
        MetricsRegistry.value('tenancy_cross_tenant_total', {
          reason: 'invite.accept',
        }),
      ).toBe(before + 1);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'rls.bypass',
          reason: 'invite.accept',
        }),
      );
      for (const labels of MetricsRegistry.labelSets(
        'tenancy_cross_tenant_total',
      ))
        expect(Object.keys(labels)).toEqual(['reason']);
      jest.restoreAllMocks();

      const [after] = await admin.query<{ bypass: string | null }>(
        `SELECT current_setting('app.rls_bypass', true) AS bypass`,
        { type: QueryTypes.SELECT },
      );
      expect(after.bypass ?? '').not.toBe('on');
    });

    it('with the bypass on, the probe role sees every shop (the one audited way across tenants)', async () => {
      const { a, b } = await seed();
      const rows = await asProbe(
        { 'app.rls_bypass': 'on', 'app.rls_bypass_reason': 'shop.purge' },
        (q) =>
          q<{ shopId: string }>(
            `SELECT DISTINCT "shopId" FROM "ShopMembership"`,
          ),
      );
      expect(rows.map((r) => r.shopId).sort()).toEqual([a.id, b.id].sort());
    });
  });

  describe('III.12: statement_timeout on connections of the probe role', () => {
    it('reports a non-zero statement_timeout and cancels a slower query with 57014', async () => {
      const [{ statement_timeout }] = await probe.query<{
        statement_timeout: string;
      }>(`SHOW statement_timeout`, { type: QueryTypes.SELECT });
      expect(statement_timeout).not.toBe('0');
      await expect(probe.query(`SELECT pg_sleep(3)`)).rejects.toMatchObject({
        parent: { code: '57014' },
      });
    });
  });
});
