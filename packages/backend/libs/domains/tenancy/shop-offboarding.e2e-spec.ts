import { Logger, Module } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { shopExportSchema } from '@marketplace-sandbox/contracts';
import {
  InvalidScheduleError,
  JobsModule,
  JobsService,
} from '@app/infrastructure/jobs';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { OidcProviderRegistry, Role, SecretBox } from '@app/domains/identity';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { PurgeShopsJobs } from './infra/jobs/purge-shops.jobs';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

const DAY = 86_400_000;

@Module({
  imports: [JobsModule],
  providers: [PurgeShopsJobs],
  exports: [PurgeShopsJobs],
})
class JobsProbeModule {}

describe('Shop lifecycle: suspension, offboarding, export and purge', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let jobs: PurgeShopsJobs;

  const statusOf = async (shopId: string) =>
    (
      await sequelize.query<{
        status: string;
        purgeAt: Date | null;
        shopVersion: string;
        name: string;
        slug: string;
      }>(
        `SELECT "status","purgeAt","shopVersion","name","slug" FROM "Shop" WHERE "id" = $1`,
        { bind: [shopId], type: QueryTypes.SELECT },
      )
    )[0];
  const history = (shopId: string) =>
    sequelize.query<{
      from: string | null;
      to: string;
      actor: string;
      reason: string | null;
    }>(
      `SELECT "from","to","actor","reason" FROM "ShopStatusHistory" WHERE "shopId" = $1 ORDER BY "at","id"`,
      { bind: [shopId], type: QueryTypes.SELECT },
    );
  const events = async (shopId: string, type: string) =>
    (await outboxRowsFor(sequelize, shopId))
      .filter((e) => e.type === type)
      .map((e) => (e.payload as { payload: Record<string, unknown> }).payload);
  const count = async (table: string, shopId: string) =>
    Number(
      (
        await sequelize.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}" WHERE "shopId" = $1`,
          { bind: [shopId], type: QueryTypes.SELECT },
        )
      )[0].n,
    );
  const admin = () => t.newUser({ role: Role.ADMIN });
  const suspend = (root: { bearer: string }, shopId: string, reason?: string) =>
    t
      .http()
      .post(`/api/admin/shops/${shopId}/suspend`)
      .set('Authorization', root.bearer)
      .send(reason === undefined ? {} : { reason });
  const reinstate = (root: { bearer: string }, shopId: string, reason = 'ok') =>
    t
      .http()
      .post(`/api/admin/shops/${shopId}/reinstate`)
      .set('Authorization', root.bearer)
      .send({ reason });

  beforeAll(async () => {
    t = await createTenancyApp({ extraImports: [JobsProbeModule] });
    sequelize = t.app.get(Sequelize);
    jobs = t.app.get(PurgeShopsJobs);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('S03 AS-65: suspend and reinstate', () => {
    it('S03 AS-65: suspends and reinstates with history, events, a version bump and the provider cache dropped', async () => {
      const owner = await t.newUser();
      const root = await admin();
      const shop = await createShop(t.app, owner);
      const dropped: string[] = [];
      t.app.get(OidcProviderRegistry).onInvalidate((id) => dropped.push(id));

      const res = await suspend(root, shop.id, 'chargebacks').expect(200);
      expect(res.body).toEqual({ id: shop.id, status: 'SUSPENDED' });
      expect((await statusOf(shop.id)).status).toBe('SUSPENDED');
      expect(dropped).toContain(`shop:${shop.id}`);
      expect(await history(shop.id)).toContainEqual({
        from: 'ACTIVE',
        to: 'SUSPENDED',
        actor: root.id,
        reason: 'chargebacks',
      });
      // read still works, writes are refused (AS-12 gate)
      await t.as(owner).get(`/api/shops/${shop.id}`).expect(200);
      await t
        .as(owner)
        .patch(`/api/shops/${shop.id}`)
        .send({ name: 'Nope' })
        .expect(403);

      const back = await reinstate(root, shop.id, 'resolved').expect(200);
      expect(back.body).toEqual({ id: shop.id, status: 'ACTIVE' });
      expect(await events(shop.id, 'tenancy.shop_status_changed')).toEqual([
        expect.objectContaining({
          from: 'ACTIVE',
          to: 'SUSPENDED',
          reason: 'chargebacks',
          shopVersion: 2,
        }),
        expect.objectContaining({
          from: 'SUSPENDED',
          to: 'ACTIVE',
          reason: 'resolved',
          shopVersion: 3,
        }),
      ]);
      expect((await statusOf(shop.id)).shopVersion).toBe('3');
      await t
        .as(owner)
        .patch(`/api/shops/${shop.id}`)
        .send({ name: 'Back' })
        .expect(200);
    });

    it('S03 AS-65: answers 409 for illegal moves, 400 without a reason, 403 to a non-administrator', async () => {
      const owner = await t.newUser();
      const root = await admin();
      const shop = await createShop(t.app, owner);
      const closing = await createShop(t.app, owner, {
        status: 'DELETING',
        purgeAt: new Date(Date.now() + DAY),
      });

      expect((await reinstate(root, shop.id).expect(409)).body.code).toBe(
        'invalid_transition',
      );
      await suspend(root, shop.id, 'x').expect(200);
      expect((await suspend(root, shop.id, 'x').expect(409)).body.code).toBe(
        'invalid_transition',
      );
      await reinstate(root, closing.id).expect(409);
      await suspend(root, closing.id, 'x').expect(409);
      await suspend(root, shop.id).expect(400);
      await suspend(root, shop.id, '').expect(400);
      await t
        .as(owner)
        .post(`/api/admin/shops/${shop.id}/reinstate`)
        .send({ reason: 'x' })
        .expect(403);
      expect((await statusOf(shop.id)).status).toBe('SUSPENDED');
      expect(await events(closing.id, 'tenancy.shop_status_changed')).toEqual(
        [],
      );
    });

    it('S03 AS-65: a suspend racing an offboarding start leaves one consistent final status', async () => {
      const owner = await t.newUser();
      const root = await admin();
      for (let i = 0; i < 5; i++) {
        const shop = await createShop(t.app, owner);
        const [a, b] = await Promise.all([
          suspend(root, shop.id, 'race'),
          t
            .as(owner)
            .post(`/api/shops/${shop.id}/offboarding`)
            .send({ confirmSlug: shop.slug }),
        ]);
        const final = (await statusOf(shop.id)).status;
        const trail = await history(shop.id);
        // Exactly one winner: a closing shop cannot be suspended (409), a suspended one cannot be closed (403).
        expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
        if (b.status === 200) {
          expect(a.status).toBe(409);
          expect(final).toBe('DELETING');
        } else {
          expect(b.status).toBe(403);
          expect(final).toBe('SUSPENDED');
        }
        expect(trail).toHaveLength(1);
        expect(trail[0].to).toBe(final);
      }
    });
  });

  describe('S03 AS-66: offboarding', () => {
    it('S03 AS-66: the owner starts it with the slug as confirmation: DELETING, purgeAt in 30 days, one event; a repeat changes nothing', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const start = () =>
        t
          .as(owner)
          .post(`/api/shops/${shop.id}/offboarding`)
          .send({ confirmSlug: shop.slug });
      const first = await start().expect(200);
      const purgeAt = new Date(t.clock.now().getTime() + 30 * DAY);
      expect(first.body).toEqual({
        status: 'DELETING',
        purgeAt: purgeAt.toISOString(),
      });
      const row = await statusOf(shop.id);
      expect(row.status).toBe('DELETING');
      expect(new Date(row.purgeAt!).toISOString()).toBe(purgeAt.toISOString());
      expect(await events(shop.id, 'tenancy.shop_offboarding_started')).toEqual(
        [
          {
            shopId: shop.id,
            purgeAt: purgeAt.toISOString(),
            shopVersion: 2,
          },
        ],
      );

      t.clock.set(new Date(t.clock.now().getTime() + DAY));
      await t.reauth(owner);
      const again = await start().expect(200);
      expect(again.body).toEqual(first.body);
      expect(
        await events(shop.id, 'tenancy.shop_offboarding_started'),
      ).toHaveLength(1);
      expect(await events(shop.id, 'tenancy.shop_status_changed')).toHaveLength(
        1,
      );
      expect((await statusOf(shop.id)).shopVersion).toBe('2');
    });

    it('S03 AS-66: refuses a wrong confirmation (422) and everyone but the owner (403), changing nothing', async () => {
      const owner = await t.newUser();
      const admin1 = await t.newUser();
      const staff = await t.newUser();
      const shop = await createShop(t.app, owner);
      await addMember(t.app, shop.id, admin1.id, 'ADMIN');
      await addMember(t.app, shop.id, staff.id, 'STAFF');
      const wrong = await t
        .as(owner)
        .post(`/api/shops/${shop.id}/offboarding`)
        .send({ confirmSlug: 'something-else' })
        .expect(422);
      expect(wrong.body.code).toBe('confirmation_mismatch');
      await t
        .as(owner)
        .post(`/api/shops/${shop.id}/offboarding`)
        .send({})
        .expect(400);
      for (const who of [admin1, staff])
        await t
          .as(who)
          .post(`/api/shops/${shop.id}/offboarding`)
          .send({ confirmSlug: shop.slug })
          .expect(403);
      expect((await statusOf(shop.id)).status).toBe('ACTIVE');
      expect(await history(shop.id)).toEqual([]);
    });

    it('S03 AS-66: a suspended shop cannot be closed by its owner: the status gate allows only reading and exporting', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner, { status: 'SUSPENDED' });
      const res = await t
        .as(owner)
        .post(`/api/shops/${shop.id}/offboarding`)
        .send({ confirmSlug: shop.slug })
        .expect(403);
      expect(res.body.code).toBe('shop_suspended');
      expect((await statusOf(shop.id)).status).toBe('SUSPENDED');
      expect(await history(shop.id)).toEqual([]);
    });

    it('S03 AS-67: the owner cancels it: ACTIVE again, purgeAt cleared, one event; cancelling an active shop is 409', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      await t.as(owner).delete(`/api/shops/${shop.id}/offboarding`).expect(409);
      await t
        .as(owner)
        .post(`/api/shops/${shop.id}/offboarding`)
        .send({ confirmSlug: shop.slug })
        .expect(200);
      const res = await t
        .as(owner)
        .delete(`/api/shops/${shop.id}/offboarding`)
        .expect(200);
      expect(res.body).toEqual({ status: 'ACTIVE' });
      const row = await statusOf(shop.id);
      expect(row.status).toBe('ACTIVE');
      expect(row.purgeAt).toBeNull();
      expect(
        await events(shop.id, 'tenancy.shop_offboarding_cancelled'),
      ).toEqual([{ shopId: shop.id, shopVersion: 3 }]);
      await t.as(owner).delete(`/api/shops/${shop.id}/offboarding`).expect(409);
    });

    it('S03 AS-67: cancelling a purged shop answers 404', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner, { status: 'DELETED' });
      await t.as(owner).delete(`/api/shops/${shop.id}/offboarding`).expect(404);
    });
  });

  describe('S03 AS-68: export', () => {
    it('S03 AS-68: the owner gets the shop, members with addresses, invites and the SSO configuration, with no secret, uncached', async () => {
      const owner = await t.newUser();
      const admin1 = await t.newUser();
      const shop = await createShop(t.app, owner, { name: 'Exported' });
      await addMember(t.app, shop.id, admin1.id, 'ADMIN');
      await createInvite(t.app, shop.id, {
        email: 'pending@example.com',
        invitedBy: owner.id,
      });
      await sequelize.query(
        `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc","defaultRole","enabled","updatedAt")
         VALUES ($1,'https://idp.example.com','client-x','v2.SEALED.SECRET.VALUE','STAFF',true,now())`,
        { bind: [shop.id] },
      );

      const res = await t
        .as(owner)
        .get(`/api/shops/${shop.id}/export`)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      shopExportSchema.parse(res.body);
      expect(res.body.shop).toMatchObject({ id: shop.id, name: 'Exported' });
      expect(typeof res.body.generatedAt).toBe('string');
      expect(res.body.members).toHaveLength(2);
      expect(res.body.members).toContainEqual(
        expect.objectContaining({
          userId: admin1.id,
          email: admin1.email,
          role: 'ADMIN',
          source: 'invite',
        }),
      );
      expect(res.body.invites).toEqual([
        expect.objectContaining({
          email: 'pending@example.com',
          role: 'STAFF',
          status: 'pending',
        }),
      ]);
      expect(res.body.sso).toEqual({
        issuer: 'https://idp.example.com',
        clientId: 'client-x',
        defaultRole: 'STAFF',
        enabled: true,
      });
      const text = JSON.stringify(res.body);
      for (const secret of ['SEALED', 'tokenHash', 'clientSecret', 'digest'])
        expect(text).not.toContain(secret);
    });

    it('S03 AS-68: works while suspended or closing, is null without SSO, and is refused to an admin', async () => {
      const owner = await t.newUser();
      const admin1 = await t.newUser();
      for (const status of ['SUSPENDED', 'DELETING'] as const) {
        const shop = await createShop(t.app, owner, { status });
        const res = await t
          .as(owner)
          .get(`/api/shops/${shop.id}/export`)
          .expect(200);
        expect(res.body.sso).toBeNull();
        await addMember(t.app, shop.id, admin1.id, 'ADMIN');
        await t.as(admin1).get(`/api/shops/${shop.id}/export`).expect(403);
      }
    });
  });

  describe('S03 AS-69: purge', () => {
    const closingShop = async () => {
      const owner = await t.newUser();
      const worker = await t.newUser();
      const plain = await t.newUser();
      const shop = await createShop(t.app, owner, { name: 'Closing Co' });
      await addMember(t.app, shop.id, worker.id, 'VIEWER', 'sso');
      await addMember(t.app, shop.id, plain.id, 'STAFF', 'invite');
      await createInvite(t.app, shop.id, {
        email: 'someone@example.com',
        invitedBy: owner.id,
      });
      await sequelize.query(
        `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc","enabled","updatedAt")
         VALUES ($1,'https://idp.example.com','c','v2.a.b.c',true,now())`,
        { bind: [shop.id] },
      );
      await t
        .as(owner)
        .post(`/api/shops/${shop.id}/offboarding`)
        .send({ confirmSlug: shop.slug })
        .expect(200);
      return { owner, worker, plain, shop };
    };

    it('S03 AS-69: does nothing before purgeAt; after it the shop becomes a tombstone with no personal data left', async () => {
      const { owner, worker, plain, shop } = await closingShop();
      const dropped: string[] = [];
      t.app.get(OidcProviderRegistry).onInvalidate((id) => dropped.push(id));

      t.clock.set(new Date(t.clock.now().getTime() + 30 * DAY - 1000));
      await expect(jobs.purgeDeletedShops()).resolves.toEqual({ purged: 0 });
      expect(await count('ShopMembership', shop.id)).toBe(3);
      expect((await statusOf(shop.id)).status).toBe('DELETING');

      t.clock.set(new Date(t.clock.now().getTime() + 2000));
      await expect(jobs.purgeDeletedShops()).resolves.toEqual({ purged: 1 });

      const row = await statusOf(shop.id);
      expect(row).toMatchObject({
        status: 'DELETED',
        name: '[deleted]',
        slug: `deleted-${shop.id}`,
        purgeAt: null,
      });
      for (const table of [
        'ShopMembership',
        'ShopInvite',
        'ShopSsoConfig',
        'ShopDirectory',
        'ShopStatusHistory',
      ])
        expect(await count(table, shop.id)).toBe(0); // SC-008
      const removed = await events(shop.id, 'tenancy.member_removed');
      expect(removed).toHaveLength(3);
      expect(removed.every((e) => e.reason === 'shop_deleted')).toBe(true);
      expect(await events(shop.id, 'tenancy.shop_deleted')).toEqual([
        { shopId: shop.id, shopVersion: Number(row.shopVersion) },
      ]);
      expect(dropped).toContain(`shop:${shop.id}`);
      // only the SSO member's sessions end
      expect((await t.session(worker.sessionId))?.revokedAt).toBeTruthy();
      expect((await t.session(plain.sessionId))?.revokedAt).toBeFalsy();
      // the former owner finds nothing (their token expired while the clock moved)
      await t.reauth(owner);
      await t.as(owner).get(`/api/shops/${shop.id}`).expect(404);
      await t.as(owner).get(`/api/shops/${shop.id}/members`).expect(404);
      // and the slug is free again
      await t
        .as(owner)
        .post('/api/shops')
        .send({ name: 'Reborn', slug: shop.slug })
        .expect(201);
    });

    it('S03 AS-69: a second run adds no event, concurrent runs purge once', async () => {
      const { shop } = await closingShop();
      t.clock.set(new Date(t.clock.now().getTime() + 31 * DAY));
      const results = await Promise.all([
        jobs.purgeDeletedShops(),
        jobs.purgeDeletedShops(),
        jobs.purgeDeletedShops(),
      ]);
      expect(results.reduce((n, r) => n + r.purged, 0)).toBe(1);
      expect(await jobs.purgeDeletedShops()).toEqual({ purged: 0 });
      expect(await events(shop.id, 'tenancy.shop_deleted')).toHaveLength(1);
      expect(await events(shop.id, 'tenancy.member_removed')).toHaveLength(3);
    });

    it('S03 AS-69: a failure on one shop rolls that shop back whole, leaves it DELETING, and does not stop the others', async () => {
      const a = await closingShop();
      const b = await closingShop();
      t.clock.set(new Date(t.clock.now().getTime() + 31 * DAY));
      await sequelize.query(`
        CREATE OR REPLACE FUNCTION tenancy_test_block_tombstone() RETURNS trigger AS $$
        BEGIN
          IF NEW."status" = 'DELETED' AND NEW."id" = '${a.shop.id}' THEN RAISE EXCEPTION 'blocked'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER tenancy_test_block BEFORE UPDATE ON "Shop"
          FOR EACH ROW EXECUTE FUNCTION tenancy_test_block_tombstone();`);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const result = await jobs.purgeDeletedShops();
        expect(result.purged).toBe(1);
      } finally {
        await sequelize.query(
          `DROP TRIGGER IF EXISTS tenancy_test_block ON "Shop"; DROP FUNCTION IF EXISTS tenancy_test_block_tombstone();`,
        );
      }
      expect((await statusOf(a.shop.id)).status).toBe('DELETING');
      expect(await count('ShopMembership', a.shop.id)).toBe(3); // rolled back whole
      expect((await statusOf(b.shop.id)).status).toBe('DELETED');
    });
  });

  it('S03 AS-70: no invite can be created, resent or accepted, and no SSO member provisioned, while the shop is suspended or closing', async () => {
    const owner = await t.newUser();
    const invitee = await t.newUser();
    for (const status of ['SUSPENDED', 'DELETING'] as const) {
      const shop = await createShop(t.app, owner, { status });
      await t
        .as(owner)
        .post(`/api/shops/${shop.id}/invites`)
        .send({ email: 'new@example.com', role: 'VIEWER' })
        .expect(status === 'SUSPENDED' ? 403 : 409);
      const { invite, token } = await createInvite(t.app, shop.id, {
        email: invitee.email,
        invitedBy: owner.id,
      });
      await t
        .as(owner)
        .post(`/api/shops/${shop.id}/invites/${invite.id}/resend`)
        .expect(status === 'SUSPENDED' ? 403 : 409);
      await t
        .as(invitee)
        .post('/api/shop-invites/accept')
        .send({ token })
        .expect(404);
      expect(
        await sequelize.query(
          `SELECT 1 FROM "ShopMembership" WHERE "shopId" = $1 AND "userId" = $2`,
          { bind: [shop.id, invitee.id], type: QueryTypes.SELECT },
        ),
      ).toHaveLength(0);
    }
  });

  describe('S03 follow-up from S49: the two jobs', () => {
    it('declares both job types and registers their schedules without UnknownJobTypeError', async () => {
      await jobs.onApplicationBootstrap();
      const names = (
        await sequelize.query<{ name: string; jobType: string }>(
          `SELECT "name","jobType" FROM "JobSchedule" WHERE "jobType" LIKE 'tenancy.%' ORDER BY "name"`,
          { type: QueryTypes.SELECT },
        )
      ).map((r) => r.jobType);
      expect(names).toEqual([
        'tenancy.purge-deleted-shops',
        'tenancy.purge-expired-invites',
        'tenancy.reseal-sso-secrets',
      ]);
    });

    it('catches InvalidScheduleError (logs it) and lets any other error through', async () => {
      const upsert = jest.spyOn(t.app.get(JobsService), 'upsertSchedule');
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      upsert.mockRejectedValue(new InvalidScheduleError('cron', 'bad'));
      await expect(jobs.onApplicationBootstrap()).resolves.toBeUndefined();
      upsert.mockRejectedValue(new Error('database down'));
      await expect(jobs.onApplicationBootstrap()).rejects.toThrow(
        'database down',
      );
    });

    it('S03 AS-70: purge-expired-invites deletes only invites 30 days past expiry, revocation or acceptance, taking their addresses with them', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const now = t.clock.now().getTime();
      const make = (email: string, over: Record<string, unknown>) =>
        createInvite(t.app, shop.id, {
          email,
          invitedBy: owner.id,
          ...over,
        });
      await make('old-expired@example.com', {
        expiresAt: new Date(now - 31 * DAY),
      });
      await make('old-revoked@example.com', {
        expiresAt: new Date(now + 7 * DAY),
        revokedAt: new Date(now - 31 * DAY),
      });
      await make('old-accepted@example.com', {
        expiresAt: new Date(now + 7 * DAY),
        acceptedAt: new Date(now - 31 * DAY),
      });
      await make('recent-expired@example.com', {
        expiresAt: new Date(now - 29 * DAY),
      });
      await make('recent-revoked@example.com', {
        expiresAt: new Date(now + 7 * DAY),
        revokedAt: new Date(now - 2 * DAY),
      });
      await make('pending@example.com', {});

      await expect(jobs.purgeExpiredInvites()).resolves.toEqual({ purged: 3 });
      const left = (
        await sequelize.query<{ email: string }>(
          `SELECT "email" FROM "ShopInvite" WHERE "shopId" = $1 ORDER BY "email"`,
          { bind: [shop.id], type: QueryTypes.SELECT },
        )
      ).map((r) => r.email);
      expect(left).toEqual([
        'pending@example.com',
        'recent-expired@example.com',
        'recent-revoked@example.com',
      ]);
      await expect(jobs.purgeExpiredInvites()).resolves.toEqual({ purged: 0 });
    });

    it('re-seals secrets sealed without a context, in batches, through the job', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const box = t.app.get(SecretBox);
      await sequelize.query(
        `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc","enabled","updatedAt")
         VALUES ($1,'https://idp.example.com','c',$2,true,now())`,
        { bind: [shop.id, box.seal('legacy')] },
      );
      await expect(jobs.resealSsoSecrets()).resolves.toEqual({ resealed: 1 });
      await expect(jobs.resealSsoSecrets()).resolves.toEqual({ resealed: 0 });
      const [row] = await sequelize.query<{ clientSecretEnc: string }>(
        `SELECT "clientSecretEnc" FROM "ShopSsoConfig" WHERE "shopId" = $1`,
        { bind: [shop.id], type: QueryTypes.SELECT },
      );
      expect(row.clientSecretEnc.startsWith('v2.')).toBe(true);
    });
  });
});
