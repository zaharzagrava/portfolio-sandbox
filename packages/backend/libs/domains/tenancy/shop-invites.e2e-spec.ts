import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  inviteAcceptedSchema,
  pageSchema,
  shopInviteSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { UserDirectoryService } from '@app/domains/identity';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import {
  createTenancyApp,
  type TenancyTestApp,
  type TestUser,
} from './testing/tenancy-app';

const invitesPage = pageSchema(shopInviteSchema);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const HOUR = 3_600_000;

describe('Invitations', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  const sql = <R extends object>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<R>(query, { type: QueryTypes.SELECT, replacements });
  const tasks = async (shopId: string) =>
    (await outboxRowsFor(t.app, shopId))
      .filter((e) => e.kind === 'task')
      .map((e) => (e.payload as { body: Record<string, string> }).body);
  const invite = (owner: TestUser, shopId: string, body: object) =>
    t.as(owner).post(`/api/shops/${shopId}/invites`).send(body);
  const accept = (user: TestUser, token: string) =>
    t.as(user).post('/api/shop-invites/accept').send({ token });
  const membersOf = (shopId: string) =>
    sql<{ userId: string; role: string; source: string }>(
      `SELECT "userId","role","source" FROM "ShopMembership" WHERE "shopId" = :shopId ORDER BY "role"`,
      { shopId },
    );
  const uniform = (res: { status: number; body: Record<string, unknown> }) => {
    const { code, title, status, detail } = res.body as Record<string, unknown>;
    return { http: res.status, code, title, status, detail };
  };

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
  });

  it('S03 AS-28: creating an invite returns metadata only, stores the digest, and hands the token to the mail queue alone', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner, { name: 'Mailers' });
    const res = await invite(owner, shop.id, {
      email: 'Invitee@Example.com ',
      role: 'STAFF',
    }).expect(201);
    const body = shopInviteSchema.parse(res.body);
    expect(body).toMatchObject({
      email: 'invitee@example.com',
      role: 'STAFF',
      status: 'pending',
      invitedBy: owner.id,
    });
    expect(new Date(body.expiresAt).getTime() - t.clock.now().getTime()).toBe(
      7 * 24 * HOUR,
    );

    const [task] = await tasks(shop.id);
    expect(task).toMatchObject({
      inviteId: body.id,
      shopId: shop.id,
      shopName: 'Mailers',
      email: 'invitee@example.com',
      role: 'STAFF',
      invitedBy: owner.id,
    });
    expect(task.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(res.body)).not.toContain(task.token);
    expect(JSON.stringify(res.headers)).not.toContain(task.token);

    const [row] = await sql<{ tokenHash: string; email: string }>(
      `SELECT "tokenHash","email" FROM "ShopInvite" WHERE "id" = :id`,
      { id: body.id },
    );
    expect(row.tokenHash).toBe(sha256(task.token));
    expect(JSON.stringify(row)).not.toContain(task.token);

    const outbox = await outboxRowsFor(t.app, shop.id);
    const created = outbox.filter((e) => e.type === 'tenancy.invite_created');
    expect(created).toHaveLength(1);
    expect(created[0].topic).toBe('tenancy.events');
    expect(JSON.stringify(created[0].payload)).not.toContain(task.token);
    const requested = outbox.filter(
      (e) => e.type === 'tenancy.invite_requested',
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ kind: 'task' });
    expect(requested[0].topic).not.toBe('tenancy.events');
  });

  it.each([
    ['not an address', { email: 'nope', role: 'STAFF' }],
    [
      'address too long',
      { email: `${'a'.repeat(250)}@example.com`, role: 'STAFF' },
    ],
    ['role OWNER', { email: 'a@example.com', role: 'OWNER' }],
    ['unknown role', { email: 'a@example.com', role: 'GOD' }],
    ['no role', { email: 'a@example.com' }],
    ['unknown field', { email: 'a@example.com', role: 'STAFF', shopId: 'x' }],
  ])(
    'S03 AS-29: %s -> 400 validation_failed and nothing is stored',
    async (_, body) => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const res = await invite(owner, shop.id, body).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(await sql(`SELECT 1 FROM "ShopInvite"`)).toHaveLength(0);
      expect(await tasks(shop.id)).toHaveLength(0);
    },
  );

  it('S03 AS-30: an existing member and a pending invite are 409; an expired invite is replaced and the old one revoked', async () => {
    const owner = await t.newUser();
    const member = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, member.id, 'STAFF');

    const already = await invite(owner, shop.id, {
      email: member.email.toUpperCase(),
      role: 'VIEWER',
    }).expect(409);
    expect(already.body.code).toBe('already_member');

    await invite(owner, shop.id, {
      email: 'pending@example.com',
      role: 'VIEWER',
    }).expect(201);
    const dup = await invite(owner, shop.id, {
      email: 'Pending@example.com',
      role: 'STAFF',
    }).expect(409);
    expect(dup.body.code).toBe('invite_pending');
    expect(
      await sql(`SELECT 1 FROM "ShopInvite" WHERE "shopId" = :id`, {
        id: shop.id,
      }),
    ).toHaveLength(1);

    t.clock.advance(8 * 24 * HOUR);
    await t.reauth(owner);
    const again = await invite(owner, shop.id, {
      email: 'pending@example.com',
      role: 'STAFF',
    }).expect(201);
    const rows = await sql<{
      id: string;
      revokedAt: Date | null;
      role: string;
    }>(
      `SELECT "id","revokedAt","role" FROM "ShopInvite" WHERE "shopId" = :id ORDER BY "createdAt"`,
      { id: shop.id },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({
      id: again.body.id,
      revokedAt: null,
      role: 'STAFF',
    });
  });

  it('S03 AS-31: seats are members plus unexpired pending invites; the last seat goes to one of two simultaneous invites; a plan change removes nobody', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner, { plan: 'STARTER' });
    for (let i = 0; i < 2; i++)
      await addMember(t.app, shop.id, (await t.newUser()).id, 'STAFF');
    await invite(owner, shop.id, {
      email: 'one@example.com',
      role: 'VIEWER',
    }).expect(201); // 3 members + 1 invite = 4

    const results = await Promise.all(
      ['two@example.com', 'three@example.com'].map((email) =>
        invite(owner, shop.id, { email, role: 'VIEWER' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'seat_limit_reached',
    );
    expect(await sql(`SELECT 1 FROM "ShopInvite"`)).toHaveLength(2);

    await sequelize.query(`UPDATE "Shop" SET "plan" = 'PRO' WHERE "id" = :id`, {
      replacements: { id: shop.id },
    });
    await invite(owner, shop.id, {
      email: 'four@example.com',
      role: 'VIEWER',
    }).expect(201);

    await sequelize.query(
      `UPDATE "Shop" SET "plan" = 'STARTER' WHERE "id" = :id`,
      { replacements: { id: shop.id } },
    );
    expect(await membersOf(shop.id)).toHaveLength(3); // nobody removed
    expect(
      (
        await invite(owner, shop.id, {
          email: 'five@example.com',
          role: 'VIEWER',
        }).expect(409)
      ).body.code,
    ).toBe('seat_limit_reached');

    t.clock.advance(8 * 24 * HOUR); // expired invites free their seats
    await t.reauth(owner);
    await invite(owner, shop.id, {
      email: 'six@example.com',
      role: 'VIEWER',
    }).expect(201);
  });

  it('S03 AS-32: the invited person accepts with the address from the directory and becomes a member', async () => {
    const owner = await t.newUser();
    const invitee = await t.newUser();
    const shop = await createShop(t.app, owner);
    await invite(owner, shop.id, {
      email: invitee.email,
      role: 'ADMIN',
    }).expect(201);
    const [{ token }] = await tasks(shop.id);

    const directory = jest.spyOn(
      t.app.get(UserDirectoryService),
      'getUsersByIds',
    );
    const res = await accept(invitee, token).expect(201);
    expect(directory).toHaveBeenCalledWith([invitee.id]);
    expect(inviteAcceptedSchema.parse(res.body)).toEqual({
      shopId: shop.id,
      role: 'ADMIN',
    });

    expect(await membersOf(shop.id)).toEqual([
      { userId: invitee.id, role: 'ADMIN', source: 'invite' },
      { userId: owner.id, role: 'OWNER', source: 'owner' },
    ]);
    const [row] = await sql<{ acceptedAt: Date; acceptedBy: string }>(
      `SELECT "acceptedAt","acceptedBy" FROM "ShopInvite"`,
    );
    expect(row.acceptedBy).toBe(invitee.id);
    expect(row.acceptedAt).toBeInstanceOf(Date);
    const added = (await outboxRowsFor(t.app, shop.id)).filter(
      (e) => e.type === 'tenancy.member_added',
    );
    expect(
      added.map(
        (e) =>
          (e.payload as { payload: { userId: string; source: string } })
            .payload,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: invitee.id, source: 'invite' }),
      ]),
    );
    await t.as(invitee).get(`/api/shops/${shop.id}`).expect(200);
  });

  it('S03 AS-33: every way an invitation can be unusable is the same 404 invite_not_found', async () => {
    const owner = await t.newUser();
    const invitee = await t.newUser();
    const nobody = await t.newUser();
    await sequelize.query(`UPDATE "User" SET "email" = NULL WHERE "id" = :id`, {
      replacements: { id: nobody.id },
    });
    const shop = await createShop(t.app, owner, { plan: 'PRO' });
    const now = t.clock.now();
    const make = (overrides: object = {}) =>
      createInvite(t.app, shop.id, {
        email: invitee.email,
        invitedBy: owner.id,
        expiresAt: new Date(now.getTime() + HOUR),
        ...overrides,
      });
    const fresh = await make();
    const expired = await make({
      email: invitee.email + '.x',
      expiresAt: new Date(now.getTime() - HOUR),
    });
    const revoked = await make({ email: invitee.email + '.y', revokedAt: now });
    const used = await make({ email: invitee.email + '.z', acceptedAt: now });

    const cases: Array<[string, TestUser, string]> = [
      ['wrong token', invitee, 'wrong-token'],
      ['empty-ish token', invitee, 'x'],
      ['expired', invitee, expired.token],
      ['revoked', invitee, revoked.token],
      ['already accepted', invitee, used.token],
      ["another person's address", owner, fresh.token],
      ['the account has no address', nobody, fresh.token],
    ];
    const answers: Array<readonly [string, ReturnType<typeof uniform>]> = [];
    for (const [name, user, token] of cases) {
      const res = await accept(user, token);
      answers.push([name, uniform(res)] as const);
    }
    for (const [name, answer] of answers) {
      expect([name, answer.http, answer.code]).toEqual([
        name,
        404,
        'invite_not_found',
      ]);
      expect(answer).toEqual(answers[0][1]);
    }
    expect(await membersOf(shop.id)).toHaveLength(1);

    t.clock.advance(2 * HOUR); // the fresh one expires with the clock, not with the wall
    await t.reauth(invitee);
    expect((await accept(invitee, fresh.token).expect(404)).body.code).toBe(
      'invite_not_found',
    );
    expect(await membersOf(shop.id)).toHaveLength(1);
  });

  it('S03 AS-34: twenty simultaneous accepts of one token produce exactly one membership', async () => {
    const owner = await t.newUser();
    const invitee = await t.newUser();
    const shop = await createShop(t.app, owner);
    await invite(owner, shop.id, {
      email: invitee.email,
      role: 'STAFF',
    }).expect(201);
    const [{ token }] = await tasks(shop.id);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => accept(invitee, token)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 201)
        .every((r) => [404, 429].includes(r.status)),
    ).toBe(true);
    expect(
      (await membersOf(shop.id)).filter((m) => m.userId === invitee.id),
    ).toHaveLength(1);
    expect(
      (await outboxRowsFor(t.app, shop.id)).filter(
        (e) =>
          e.type === 'tenancy.member_added' &&
          (e.payload as { payload: { userId: string } }).payload.userId ===
            invitee.id,
      ),
    ).toHaveLength(1);
  });

  it('S03 AS-35: an existing member who accepts keeps their role (200 alreadyMember) and the invite is consumed', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    await invite(owner, shop.id, { email: owner.email, role: 'VIEWER' }).expect(
      409,
    ); // refused up front...
    const { token, invite: row } = await createInvite(t.app, shop.id, {
      email: owner.email,
      invitedBy: owner.id,
      role: 'VIEWER',
    }); // ...but one may predate the membership
    const res = await accept(owner, token).expect(200);
    expect(inviteAcceptedSchema.parse(res.body)).toEqual({
      shopId: shop.id,
      role: 'OWNER',
      alreadyMember: true,
    });
    expect(await membersOf(shop.id)).toEqual([
      { userId: owner.id, role: 'OWNER', source: 'owner' },
    ]);
    const [after] = await sql<{ acceptedAt: Date | null }>(
      `SELECT "acceptedAt" FROM "ShopInvite" WHERE "id" = :id`,
      { id: row.id },
    );
    expect(after.acceptedAt).not.toBeNull();
    expect((await accept(owner, token).expect(404)).body.code).toBe(
      'invite_not_found',
    );
  });

  it("S03 AS-36: revoking is final and idempotent; an accepted invite cannot be revoked; another shop's invite is not found", async () => {
    const owner = await t.newUser();
    const other = await t.newUser();
    const shop = await createShop(t.app, owner);
    const otherShop = await createShop(t.app, other);
    const pending = await createInvite(t.app, shop.id, {
      email: 'p@example.com',
      invitedBy: owner.id,
    });
    const done = await createInvite(t.app, shop.id, {
      email: 'd@example.com',
      invitedBy: owner.id,
      acceptedAt: new Date(),
    });
    const foreign = await createInvite(t.app, otherShop.id, {
      email: 'f@example.com',
      invitedBy: other.id,
    });

    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/invites/${pending.invite.id}`)
      .expect(204);
    const [revoked] = await sql<{ revokedAt: Date | null }>(
      `SELECT "revokedAt" FROM "ShopInvite" WHERE "id" = :id`,
      { id: pending.invite.id },
    );
    expect(revoked.revokedAt).not.toBeNull();
    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/invites/${pending.invite.id}`)
      .expect(204);
    expect(
      (await accept(await t.newUser(), pending.token).expect(404)).body.code,
    ).toBe('invite_not_found');

    const conflict = await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/invites/${done.invite.id}`)
      .expect(409);
    expect(conflict.body.code).toBe('invalid_transition');
    const notFound = await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/invites/${foreign.invite.id}`)
      .expect(404);
    expect(notFound.body.code).toBe('invite_not_found');
    const [untouched] = await sql<{ revokedAt: Date | null }>(
      `SELECT "revokedAt" FROM "ShopInvite" WHERE "id" = :id`,
      { id: foreign.invite.id },
    );
    expect(untouched.revokedAt).toBeNull();
  });

  it('S03 AS-37: resending issues a new token, kills the old one and refreshes the expiry; accepted and revoked invites cannot be resent', async () => {
    const owner = await t.newUser();
    const invitee = await t.newUser();
    const shop = await createShop(t.app, owner);
    await invite(owner, shop.id, {
      email: invitee.email,
      role: 'STAFF',
    }).expect(201);
    const [{ token: oldToken, inviteId }] = await tasks(shop.id);

    t.clock.advance(3 * 24 * HOUR);
    await t.reauth(owner);
    await t.reauth(invitee);
    const res = await t
      .as(owner)
      .post(`/api/shops/${shop.id}/invites/${inviteId}/resend`)
      .expect(200);
    const body = shopInviteSchema.parse(res.body);
    expect(new Date(body.expiresAt).getTime() - t.clock.now().getTime()).toBe(
      7 * 24 * HOUR,
    );
    const all = await tasks(shop.id);
    expect(all).toHaveLength(2);
    const newToken = all[1].token;
    expect(newToken).not.toBe(oldToken);
    expect(JSON.stringify(res.body)).not.toContain(newToken);
    const [row] = await sql<{ tokenHash: string }>(
      `SELECT "tokenHash" FROM "ShopInvite" WHERE "id" = :id`,
      { id: inviteId },
    );
    expect(row.tokenHash).toBe(sha256(newToken));

    expect((await accept(invitee, oldToken).expect(404)).body.code).toBe(
      'invite_not_found',
    );
    await accept(invitee, newToken).expect(201);

    const done = await t
      .as(owner)
      .post(`/api/shops/${shop.id}/invites/${inviteId}/resend`)
      .expect(409);
    expect(done.body.code).toBe('invalid_transition');
    const gone = await createInvite(t.app, shop.id, {
      email: 'g@example.com',
      invitedBy: owner.id,
      revokedAt: new Date(),
    });
    expect(
      (
        await t
          .as(owner)
          .post(`/api/shops/${shop.id}/invites/${gone.invite.id}/resend`)
          .expect(409)
      ).body.code,
    ).toBe('invalid_transition');
  });

  it('S03 AS-38: the list derives each status from time, filters by it, pages by cursor and shows no digest or token', async () => {
    const owner = await t.newUser();
    const viewer = await t.newUser();
    const shop = await createShop(t.app, owner, { plan: 'PRO' });
    await addMember(t.app, shop.id, viewer.id, 'VIEWER');
    const now = t.clock.now();
    const at = (n: number) => new Date(now.getTime() - n * HOUR);
    const pending = await createInvite(t.app, shop.id, {
      email: 'a@example.com',
      invitedBy: owner.id,
      createdAt: at(5),
      expiresAt: new Date(now.getTime() + HOUR),
    });
    await createInvite(t.app, shop.id, {
      email: 'b@example.com',
      invitedBy: owner.id,
      createdAt: at(4),
      expiresAt: at(1),
    });
    await createInvite(t.app, shop.id, {
      email: 'c@example.com',
      invitedBy: owner.id,
      createdAt: at(3),
      revokedAt: at(2),
    });
    await createInvite(t.app, shop.id, {
      email: 'd@example.com',
      invitedBy: owner.id,
      createdAt: at(2),
      acceptedAt: at(1),
    });

    const all = await t
      .as(owner)
      .get(`/api/shops/${shop.id}/invites`)
      .expect(200);
    const page = invitesPage.parse(all.body);
    expect(page.items.map((i) => [i.email, i.status])).toEqual([
      ['d@example.com', 'accepted'],
      ['c@example.com', 'revoked'],
      ['b@example.com', 'expired'],
      ['a@example.com', 'pending'],
    ]);
    expect(JSON.stringify(all.body)).not.toMatch(
      /tokenHash|tokenDigest|token/i,
    );
    expect(JSON.stringify(all.body)).not.toContain(sha256(pending.token));

    const onlyPending = invitesPage.parse(
      (
        await t
          .as(owner)
          .get(`/api/shops/${shop.id}/invites?status=pending`)
          .expect(200)
      ).body,
    );
    expect(onlyPending.items.map((i) => i.email)).toEqual(['a@example.com']);

    const first = invitesPage.parse(
      (
        await t
          .as(owner)
          .get(`/api/shops/${shop.id}/invites?limit=3`)
          .expect(200)
      ).body,
    );
    expect(first.items).toHaveLength(3);
    const second = invitesPage.parse(
      (
        await t
          .as(owner)
          .get(
            `/api/shops/${shop.id}/invites?limit=3&cursor=${first.nextCursor}`,
          )
          .expect(200)
      ).body,
    );
    expect(second.items.map((i) => i.email)).toEqual(['a@example.com']);
    expect(second.nextCursor).toBeNull();

    for (const q of ['status=bogus', 'cursor=junk', 'limit=101'])
      expect(
        (
          await t
            .as(owner)
            .get(`/api/shops/${shop.id}/invites?${q}`)
            .expect(400)
        ).body.code,
      ).toBe('validation_failed');
    expect(
      (await t.as(viewer).get(`/api/shops/${shop.id}/invites`).expect(403)).body
        .code,
    ).toBe('permission_denied');
  });

  it('S03 AS-39: the 21st invite of a shop in an hour is 429 and another shop is unaffected; the 11th failed accept of a user is 429 and another user is unaffected', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner, { plan: 'ENTERPRISE' });
    const otherShop = await createShop(t.app, owner, { plan: 'ENTERPRISE' });
    for (let i = 0; i < 20; i++)
      await invite(owner, shop.id, {
        email: `u${i}@example.com`,
        role: 'VIEWER',
      }).expect(201);
    const limited = await invite(owner, shop.id, {
      email: 'u20@example.com',
      role: 'VIEWER',
    }).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(
      await sql(`SELECT 1 FROM "ShopInvite" WHERE "email" = 'u20@example.com'`),
    ).toHaveLength(0);
    await invite(owner, otherShop.id, {
      email: 'free@example.com',
      role: 'VIEWER',
    }).expect(201);

    const guesser = await t.newUser();
    const honest = await t.newUser();
    for (let i = 0; i < 10; i++)
      await accept(guesser, `guess-${i}`).expect(404);
    const blocked = await accept(guesser, 'guess-11').expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.code).toBe('rate_limited');
    await accept(honest, 'guess-12').expect(404);
  });

  it('S03 FR-090: the 31st accept attempt in a minute from one address is 429 with Retry-After', async () => {
    const users = await Promise.all([t.newUser(), t.newUser(), t.newUser()]);
    for (let i = 0; i < 30; i++)
      await accept(users[i % 3], `ip-guess-${i}`).expect(404);
    const limited = await accept(users[0], 'ip-guess-31').expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
