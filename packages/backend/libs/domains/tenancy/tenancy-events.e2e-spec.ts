import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { eventEnvelopeSchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { ShopProvisioningService } from './application/shop-provisioning.service';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

describe('Events of the tenancy domain', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  const outboxCount = async () =>
    Number(
      (
        await sequelize.query<{ n: string }>(
          `SELECT count(*) AS n FROM "Outbox"`,
          { type: QueryTypes.SELECT },
        )
      )[0].n,
    );
  const snapshot = async () => ({
    shops: await sequelize.query(`SELECT * FROM "Shop" ORDER BY "id"`, {
      type: QueryTypes.SELECT,
    }),
    members: await sequelize.query(
      `SELECT * FROM "ShopMembership" ORDER BY "shopId","userId"`,
      { type: QueryTypes.SELECT },
    ),
    invites: await sequelize.query(`SELECT * FROM "ShopInvite" ORDER BY "id"`, {
      type: QueryTypes.SELECT,
    }),
    directory: await sequelize.query(
      `SELECT * FROM "ShopDirectory" ORDER BY "shopId"`,
      { type: QueryTypes.SELECT },
    ),
    history: await sequelize.query(
      `SELECT * FROM "ShopStatusHistory" ORDER BY "id"`,
      { type: QueryTypes.SELECT },
    ),
  });
  const failOutbox = () =>
    sequelize.query(`
      CREATE OR REPLACE FUNCTION tenancy_test_fail_outbox() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'outbox is down'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER tenancy_test_fail_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION tenancy_test_fail_outbox();`);
  const healOutbox = () =>
    sequelize.query(
      `DROP TRIGGER IF EXISTS tenancy_test_fail_outbox ON "Outbox"; DROP FUNCTION IF EXISTS tenancy_test_fail_outbox();`,
    );

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await healOutbox();
    await t.reset();
  });

  /** A shop with an owner, an admin, a staff member, a pending invite and an invite for a registered person. */
  const world = async () => {
    const owner = await t.newUser();
    const admin = await t.newUser();
    const staff = await t.newUser();
    const invitee = await t.newUser();
    const shop = await createShop(t.app, owner, { plan: 'PRO' });
    await addMember(t.app, shop.id, admin.id, 'ADMIN');
    await addMember(t.app, shop.id, staff.id, 'STAFF');
    const pending = await createInvite(t.app, shop.id, {
      email: 'pending@example.com',
      invitedBy: owner.id,
    });
    const forInvitee = await createInvite(t.app, shop.id, {
      email: invitee.email,
      invitedBy: owner.id,
    });
    return { owner, admin, staff, invitee, shop, pending, forInvitee };
  };

  it('S03 AS-78: when the outbox append fails, every mutation rolls back completely', async () => {
    const w = await world();
    const sellerToProvision = await t.newUser();
    const attempts: Array<[string, () => Promise<{ status: number }>]> = [
      [
        'create shop',
        () =>
          t
            .as(w.owner)
            .post('/api/shops')
            .send({ name: 'Doomed', slug: 'doomed-shop' }),
      ],
      [
        'rename shop',
        () =>
          t
            .as(w.owner)
            .patch(`/api/shops/${w.shop.id}`)
            .send({ name: 'Doomed rename' }),
      ],
      [
        'change role',
        () =>
          t
            .as(w.owner)
            .patch(`/api/shops/${w.shop.id}/members/${w.staff.id}`)
            .send({ role: 'ADMIN' }),
      ],
      [
        'remove member',
        () =>
          t.as(w.owner).delete(`/api/shops/${w.shop.id}/members/${w.staff.id}`),
      ],
      [
        'leave shop',
        () =>
          t.as(w.staff).delete(`/api/shops/${w.shop.id}/members/${w.staff.id}`),
      ],
      [
        'create invite',
        () =>
          t
            .as(w.owner)
            .post(`/api/shops/${w.shop.id}/invites`)
            .send({ email: 'doomed@example.com', role: 'STAFF' }),
      ],
      [
        'resend invite',
        () =>
          t
            .as(w.owner)
            .post(
              `/api/shops/${w.shop.id}/invites/${w.pending.invite.id}/resend`,
            ),
      ],
      [
        'accept invite',
        () =>
          t
            .as(w.invitee)
            .post('/api/shop-invites/accept')
            .send({ token: w.forInvitee.token }),
      ],
      [
        'provision legacy seller',
        async () => {
          try {
            await t.app
              .get(ShopProvisioningService)
              .ensureShopsForLegacySellers([sellerToProvision.id]);
            return { status: 200 };
          } catch {
            return { status: 500 };
          }
        },
      ],
    ];
    const before = await snapshot();
    const outboxBefore = await outboxCount();
    await failOutbox();
    try {
      for (const [name, attempt] of attempts) {
        const res = await attempt();
        expect([name, res.status]).toEqual([name, 500]);
      }
    } finally {
      await healOutbox();
    }
    expect(await snapshot()).toEqual(before);
    expect(await outboxCount()).toBe(outboxBefore);
  });

  it('S03 AS-78: a rejected operation appends nothing', async () => {
    const w = await world();
    const outsider = await t.newUser();
    const before = await outboxCount();
    const rejected: Array<[number, Promise<{ status: number }>]> = [
      [
        409,
        t
          .as(w.owner)
          .patch(`/api/shops/${w.shop.id}/members/${w.owner.id}`)
          .send({ role: 'VIEWER' }),
      ],
      [
        403,
        t
          .as(w.admin)
          .patch(`/api/shops/${w.shop.id}/members/${w.owner.id}`)
          .send({ role: 'VIEWER' }),
      ],
      [
        404,
        t
          .as(w.owner)
          .patch(`/api/shops/${w.shop.id}/members/${outsider.id}`)
          .send({ role: 'VIEWER' }),
      ],
      [400, t.as(w.owner).patch(`/api/shops/${w.shop.id}`).send({ name: 'x' })],
      [
        404,
        t
          .as(outsider)
          .patch(`/api/shops/${w.shop.id}`)
          .send({ name: 'Intruder' }),
      ],
      [
        409,
        t
          .as(w.owner)
          .post(`/api/shops/${w.shop.id}/invites`)
          .send({ email: 'pending@example.com', role: 'STAFF' }),
      ],
      [
        403,
        t
          .as(w.admin)
          .post(`/api/shops/${w.shop.id}/invites`)
          .send({ email: 'new@example.com', role: 'ADMIN' }),
      ],
      [
        404,
        t.as(outsider).post('/api/shop-invites/accept').send({ token: 'nope' }),
      ],
      [
        409,
        t
          .as(w.owner)
          .post('/api/shops')
          .send({ name: 'Taken', slug: w.shop.slug }),
      ],
    ];
    for (const [status, req] of rejected)
      expect((await req).status).toBe(status);
    expect(await outboxCount()).toBe(before);
  });

  it('S03 AS-78: every event is a valid envelope keyed by the shop, with identifiers only and the shop version where stated', async () => {
    const w = await world();
    const owner = w.owner;
    const created = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Eventful', slug: 'eventful' })
      .expect(201);
    const eventful = created.body.id as string;
    await t
      .as(owner)
      .patch(`/api/shops/${eventful}`)
      .send({ name: 'Eventful 2' })
      .expect(200);
    await t
      .as(owner)
      .patch(`/api/shops/${w.shop.id}/members/${w.staff.id}`)
      .send({ role: 'ADMIN' })
      .expect(204);
    await t
      .as(owner)
      .delete(`/api/shops/${w.shop.id}/members/${w.admin.id}`)
      .expect(204);
    await t
      .as(owner)
      .post(`/api/shops/${w.shop.id}/invites`)
      .send({ email: 'someone@example.com', role: 'VIEWER' })
      .expect(201);
    await t
      .as(w.invitee)
      .post('/api/shop-invites/accept')
      .send({ token: w.forInvitee.token })
      .expect(201);

    const rows = [
      ...(await outboxRowsFor(t.app, eventful)),
      ...(await outboxRowsFor(t.app, w.shop.id)),
    ];
    const events = rows.filter((r) => r.kind === 'event');
    const types = new Set(events.map((e) => e.type));
    for (const type of [
      'tenancy.shop_created',
      'tenancy.shop_updated',
      'tenancy.member_added',
      'tenancy.member_role_changed',
      'tenancy.member_removed',
      'tenancy.invite_created',
    ])
      expect(types).toContain(type);

    for (const event of events) {
      const envelope = eventEnvelopeSchema.parse(event.payload);
      expect(event.topic).toBe('tenancy.events');
      expect(envelope).toMatchObject({ aggregateType: 'tenancy', version: 1 });
      expect([eventful, w.shop.id]).toContain(envelope.aggregateId);
      expect(envelope.payload.shopId).toBe(envelope.aggregateId);
      expect(Number.isInteger(envelope.aggregateVersion)).toBe(true);
      const text = JSON.stringify(envelope.payload);
      expect(text).not.toMatch(/@/); // no address
      expect(text).not.toMatch(/token|secret|password/i);
    }
    const updated = events.find((e) => e.type === 'tenancy.shop_updated')!;
    expect(eventEnvelopeSchema.parse(updated.payload)).toMatchObject({
      aggregateVersion: 2,
      payload: { shopVersion: 2 },
    });
  });

  it('S03 AS-78: the invite message is the one carrier of a secret and never goes to the fan-out topic', async () => {
    const w = await world();
    await t
      .as(w.owner)
      .post(`/api/shops/${w.shop.id}/invites`)
      .send({ email: 'carrier@example.com', role: 'VIEWER' })
      .expect(201);
    const rows = await outboxRowsFor(t.app, w.shop.id);
    const tasks = rows.filter((r) => r.kind === 'task');
    expect(tasks.map((r) => r.type)).toEqual(['tenancy.invite_requested']);
    expect(tasks[0].topic).not.toBe('tenancy.events');
    const withSecret = rows.filter((r) =>
      /"token"/.test(JSON.stringify(r.payload)),
    );
    expect(withSecret.map((r) => r.type)).toEqual(['tenancy.invite_requested']);
    expect(
      rows
        .filter((r) => r.topic === 'tenancy.events')
        .every((r) => !/carrier@example\.com/.test(JSON.stringify(r.payload))),
    ).toBe(true);
  });
});
