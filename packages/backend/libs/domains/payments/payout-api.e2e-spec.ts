import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  adminPayoutPageSchema,
  adminPayoutSchema,
  payoutDestinationResponseSchema,
  payoutDetailSchema,
  payoutPageSchema,
  payoutReserveResponseSchema,
  payoutRunPageSchema,
  payoutSchema,
  upcomingPayoutSchema,
} from '@marketplace-sandbox/contracts';
import { Role } from '@app/domains/identity';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import type { TestUser } from '@app/test/utils/catalog-app';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { PayoutDestinationService } from './application/payout-destination.service';
import {
  assertPayoutBooks,
  createGate,
  createPayoutApp,
  fund,
  payoutOf,
  PERIOD,
  RUN_AT,
  seedDestination,
  seller,
  shopBalance,
  type PayoutTestApp,
} from './testing';
import { sql } from './testing/ledger-fixtures';

const first = { attempt: 1, isLastAttempt: false };
const H = 3_600_000;

describe('Payouts: seller and operator API', () => {
  let t: PayoutTestApp;
  let admin: TestUser;
  let owner: TestUser;
  let shopId: string;

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
    admin = await t.newUser({ role: Role.ADMIN });
    owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    shopId = shop.id;
    t.shops.set(shopId);
    await seedDestination(t, shopId);
  });

  /** One payout per period for `shopId`, each created by the real run at its own funded balance. */
  const payoutsFor = async (periods: string[], forShop = shopId) => {
    for (const period of periods) {
      await fund(t, forShop, 20_000);
      await t.run.run({ periodStart: period });
    }
  };
  const get = (who: TestUser | null, url: string) =>
    who ? t.as(who).get(`/api${url}`) : t.http().get(`/api${url}`);
  const write = (
    method: 'put' | 'post',
    who: TestUser | null,
    url: string,
    body: unknown,
    key: string | null = `k-${uuidv4()}`,
  ) => {
    let req = who
      ? t.as(who)[method](`/api${url}`)
      : t.http()[method](`/api${url}`);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req.send(body as object);
  };
  const setDestination = (
    who: TestUser | null,
    id: string,
    body: unknown,
    key?: string | null,
  ) => write('put', who, `/finance/shops/${id}/payout-destination`, body, key);
  const setReserve = (
    who: TestUser | null,
    id: string,
    body: unknown,
    key?: string | null,
  ) => write('put', who, `/finance/shops/${id}/payout-reserve`, body, key);
  const cancel = (
    who: TestUser | null,
    id: string,
    body: unknown,
    key?: string | null,
  ) => write('post', who, `/finance/payouts/${id}/cancel`, body, key);

  describe('the seller reads', () => {
    it('S15 AS-31: a member sees their own payouts newest first with public statuses and no internal field', async () => {
      await payoutsFor(['2026-09-14', '2026-09-21', '2026-09-28', PERIOD]);
      const rows = await sql<{ id: string; periodStart: string }>(
        t.app,
        `SELECT "id", "periodStart"::text AS "periodStart" FROM "Payout" ORDER BY "periodStart"`,
      );
      await t.transfers.send(rows[0].id, first); // PAID
      t.provider.next({ kind: 'timeout' });
      await t.transfers.send(rows[1].id, first); // UNKNOWN, shown as IN_TRANSIT
      const other = await seller(t, { balance: 20_000 });
      await t.run.run({ periodStart: PERIOD });

      const res = await get(owner, `/shops/${shopId}/payouts`);

      expect(res.status).toBe(200);
      const page = payoutPageSchema.parse(res.body);
      expect(page.items.map((i) => i.periodStart)).toEqual([
        PERIOD,
        '2026-09-28',
        '2026-09-21',
        '2026-09-14',
      ]);
      expect(page.items.map((i) => i.status)).toEqual([
        'PENDING',
        'PENDING',
        'IN_TRANSIT',
        'PAID',
      ]);
      expect(page.nextCursor).toBeNull();
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(
          Object.keys(payoutSchema.shape).sort(),
        );
        expect(item.shopId).toBe(shopId);
      }
      expect(JSON.stringify(res.body)).not.toContain('acct_');
      expect(JSON.stringify(res.body)).not.toContain(other.shopId);
    });

    it('S15 AS-32: pages of 2, 2 and 1 repeat and skip nothing across an insert; the default page is 20; bad limits and cursors are 400', async () => {
      await payoutsFor([
        '2026-08-31',
        '2026-09-07',
        '2026-09-14',
        '2026-09-21',
        '2026-09-28',
      ]);
      const seen: string[] = [];
      const one = await get(owner, `/shops/${shopId}/payouts?limit=2`);
      const p1 = payoutPageSchema.parse(one.body);
      seen.push(...p1.items.map((i) => i.periodStart));
      await payoutsFor([PERIOD]); // a newer payout appears between the pages
      const two = await get(
        owner,
        `/shops/${shopId}/payouts?limit=2&cursor=${p1.nextCursor}`,
      );
      const p2 = payoutPageSchema.parse(two.body);
      seen.push(...p2.items.map((i) => i.periodStart));
      const three = await get(
        owner,
        `/shops/${shopId}/payouts?limit=2&cursor=${p2.nextCursor}`,
      );
      const p3 = payoutPageSchema.parse(three.body);
      seen.push(...p3.items.map((i) => i.periodStart));

      expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([
        2, 2, 1,
      ]);
      expect(seen).toEqual([
        '2026-09-28',
        '2026-09-21',
        '2026-09-14',
        '2026-09-07',
        '2026-08-31',
      ]);
      expect(p3.nextCursor).toBeNull();
      expect(
        payoutPageSchema.parse(
          (await get(owner, `/shops/${shopId}/payouts`)).body,
        ).items,
      ).toHaveLength(6);

      for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5'])
        expect(
          (await get(owner, `/shops/${shopId}/payouts?${bad}`)).body.code,
        ).toBe('validation_failed');
      const tampered = `${p1.nextCursor!.slice(0, -2)}xx`;
      const res = await get(
        owner,
        `/shops/${shopId}/payouts?cursor=${tampered}`,
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
      const foreign = await get(admin, '/finance/payouts?limit=1');
      const adminCursor = adminPayoutPageSchema.parse(foreign.body).nextCursor;
      expect(
        (await get(owner, `/shops/${shopId}/payouts?cursor=${adminCursor}`))
          .body.code,
      ).toBe('invalid_cursor');
    });

    it("S15 AS-33: one payout comes with its timeline; another shop's payout and an unknown id answer identically", async () => {
      await payoutsFor([PERIOD]);
      const mine = await payoutOf(t, shopId);
      await t.transfers.send(mine.id, first);
      const other = await seller(t, { balance: 20_000 });
      await t.run.run({ periodStart: PERIOD });
      const theirs = await payoutOf(t, other.shopId);

      const res = await get(owner, `/shops/${shopId}/payouts/${mine.id}`);

      expect(res.status).toBe(200);
      const detail = payoutDetailSchema.parse(res.body);
      expect(detail.status).toBe('PAID');
      expect(detail.timeline.map((e) => e.status)).toEqual([
        'PENDING',
        'IN_TRANSIT',
        'PAID',
      ]);
      const foreign = await get(owner, `/shops/${shopId}/payouts/${theirs.id}`);
      const unknown = await get(owner, `/shops/${shopId}/payouts/${uuidv4()}`);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('payout_not_found');
      const pick = ({
        type,
        title,
        status,
        detail: d,
        code,
      }: Record<string, unknown>) => ({ type, title, status, d, code });
      expect(pick(foreign.body)).toEqual(pick(unknown.body));
      expect(
        (await get(owner, `/shops/${shopId}/payouts/not-a-uuid`)).status,
      ).toBe(400);
    });

    it('S15 AS-34: no session is 401, a non-member 404 like an unknown shop, a viewer 403, a closed shop refuses with the gate codes', async () => {
      await payoutsFor([PERIOD]);
      const stranger = await t.newUser();
      const viewer = await t.newUser();
      await addMember(t.app, shopId, viewer.id, 'VIEWER');
      const paths = [
        `/shops/${shopId}/payouts`,
        `/shops/${shopId}/payouts/upcoming`,
        `/shops/${shopId}/payouts/${(await payoutOf(t, shopId)).id}`,
      ];
      for (const path of paths) {
        expect((await get(null, path)).status).toBe(401);
        const nonMember = await get(stranger, path);
        expect(nonMember.status).toBe(404);
        expect(nonMember.body.code).toBe('shop_not_found');
        const denied = await get(viewer, path);
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('permission_denied');
        expect((await get(owner, path)).status).toBe(200);
      }
      const unknownShop = await get(stranger, `/shops/${uuidv4()}/payouts`);
      const foreignShop = await get(stranger, `/shops/${shopId}/payouts`);
      expect(foreignShop.body.code).toBe(unknownShop.body.code);
      expect(foreignShop.body.detail).toBe(unknownShop.body.detail);

      // S03 follow-up retest: tenancy's status gate covers every permission outside its short allow-list, and
      // `payouts.read` is not in it, so a closed shop's members are refused with the gate's own codes.
      const suspended = await createShop(t.app, owner, { status: 'SUSPENDED' });
      const refused = await get(owner, `/shops/${suspended.id}/payouts`);
      expect([refused.status, refused.body.code]).toEqual([
        403,
        'shop_suspended',
      ]);
      const deleting = await createShop(t.app, owner, { status: 'DELETING' });
      const offboarding = await get(owner, `/shops/${deleting.id}/payouts`);
      expect([offboarding.status, offboarding.body.code]).toEqual([
        409,
        'shop_offboarding',
      ]);
    });

    it('S15 AS-35: the upcoming payout shows the amount, the reserve, the next run and, when blocked, why', async () => {
      t.clock.set(new Date('2026-10-07T10:00:00.000Z'));
      await t.reauth(owner);
      await fund(t, shopId, 50_000);

      const ok = await get(owner, `/shops/${shopId}/payouts/upcoming`);

      expect(ok.status).toBe(200);
      expect(upcomingPayoutSchema.parse(ok.body)).toEqual({
        shopId,
        currency: 'EUR',
        availableMinor: 50_000,
        reserveMinor: 5_000,
        estimatedPayoutMinor: 45_000,
        nextRunAt: '2026-10-12T04:00:00.000Z',
        blockedReason: null,
      });

      const reasonOf = async (
        setup: () => Promise<unknown>,
        expected: string,
      ) => {
        await setup();
        const res = await get(owner, `/shops/${shopId}/payouts/upcoming`);
        const body = upcomingPayoutSchema.parse(res.body);
        expect(body.blockedReason).toBe(expected);
        expect(body.estimatedPayoutMinor).toBe(0);
      };
      await reasonOf(
        async () => t.shops.set(shopId, { payoutsEnabled: false }),
        'payouts_disabled',
      );
      t.shops.set(shopId);
      await reasonOf(
        () =>
          sql(
            t.app,
            `DELETE FROM "PayoutDestination" WHERE "shopId" = :shopId`,
            { shopId },
          ),
        'destination_missing',
      );
      await reasonOf(
        () =>
          seedDestination(
            t,
            shopId,
            'acct_COOLINGACCT01',
            new Date(Date.now() + 100 * H),
          ),
        'destination_cooling',
      );
      await seedDestination(t, shopId);
      await reasonOf(async () => fund(t, shopId, -49_500), 'below_minimum');

      await fund(t, shopId, -2_000);
      const negative = upcomingPayoutSchema.parse(
        (await get(owner, `/shops/${shopId}/payouts/upcoming`)).body,
      );
      expect(negative).toMatchObject({
        availableMinor: -1_500,
        reserveMinor: 0,
        blockedReason: 'below_minimum',
      });
    });

    it('S15 AS-36: the 121st read in a minute is 429 with Retry-After', async () => {
      // 120 reads in waves of 30 at once (was one by one)
      for (let wave = 0; wave < 4; wave += 1)
        expect(
          (
            await Promise.all(
              Array.from({ length: 30 }, () =>
                get(owner, `/shops/${shopId}/payouts`),
              ),
            )
          ).map((r) => r.status),
        ).toEqual(Array(30).fill(200));
      const limited = await get(owner, `/shops/${shopId}/payouts`);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });
  });

  describe('the operator sets destinations and reserves', () => {
    it('S15 AS-38: a destination is stored once, returned masked, kept out of logs, and bad input is refused with its own status', async () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation(
            (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
          );
      const fresh = uuidv4();
      t.shops.set(fresh);
      await sql(t.app, `DELETE FROM "PayoutDestination"`);

      const res = await setDestination(admin, fresh, {
        providerAccountId: 'acct_1AbCdEfGh2',
      });

      expect(res.status).toBe(200);
      const body = payoutDestinationResponseSchema.parse(res.body);
      expect(body).toMatchObject({
        shopId: fresh,
        providerAccountId: 'acct_…Gh2',
        status: 'ACTIVE',
      });
      expect(body.effectiveFrom).toBe(body.changedAt);
      expect(JSON.stringify(res.body)).not.toContain('1AbCdEfGh');
      expect(
        await sql(
          t.app,
          `SELECT "providerAccountId" FROM "PayoutDestination" WHERE "shopId" = :fresh`,
          { fresh },
        ),
      ).toEqual([{ providerAccountId: 'acct_1AbCdEfGh2' }]);
      expect(
        await sql(
          t.app,
          `SELECT "fromMasked", "toMasked", "actor" FROM "PayoutDestinationHistory" WHERE "shopId" = :fresh`,
          { fresh },
        ),
      ).toEqual([{ fromMasked: null, toMasked: 'acct_…Gh2', actor: admin.id }]);
      expect(lines.join('\n')).not.toContain('1AbCdEfGh');

      expect(
        (await setDestination(admin, fresh, { providerAccountId: 'bogus' }))
          .body.code,
      ).toBe('destination_invalid');
      expect(
        (await setDestination(admin, fresh, { providerAccountId: 'bogus' }))
          .status,
      ).toBe(422);
      expect(
        (await setDestination(admin, fresh, { providerAccountId: 42 })).status,
      ).toBe(400);
      expect(
        (
          await setDestination(admin, fresh, {
            providerAccountId: 'acct_12345678',
            extra: 1,
          })
        ).status,
      ).toBe(400);
      const unknown = await setDestination(admin, uuidv4(), {
        providerAccountId: 'acct_12345678',
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('shop_not_found');
      expect(
        (
          await setDestination(owner, fresh, {
            providerAccountId: 'acct_12345678',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await setDestination(null, fresh, {
            providerAccountId: 'acct_12345678',
          })
        ).status,
      ).toBe(401);
    });

    it('S15 AS-39: a changed destination counts after 48 hours; the same value changes nothing', async () => {
      const first1 = await setDestination(admin, shopId, {
        providerAccountId: 'acct_NEWDESTINATION1',
      });
      const changedAt = new Date(first1.body.changedAt);
      expect(new Date(first1.body.effectiveFrom).getTime()).toBe(
        changedAt.getTime() + 48 * H,
      );

      t.clock.advance(H);
      admin = await t.newUser({ role: Role.ADMIN }); // the access token of the first one has expired on this clock
      const again = await setDestination(admin, shopId, {
        providerAccountId: 'acct_NEWDESTINATION1',
      });
      expect(again.status).toBe(200);
      expect(again.body.changedAt).toBe(first1.body.changedAt);
      expect(again.body.effectiveFrom).toBe(first1.body.effectiveFrom);
      expect(
        await sql(
          t.app,
          `SELECT "version" FROM "PayoutDestination" WHERE "shopId" = :shopId`,
          { shopId },
        ),
      ).toEqual([{ version: 2 }]);
      expect(
        Number(
          (
            await sql<{ n: string }>(
              t.app,
              `SELECT count(*)::text AS n FROM "PayoutDestinationHistory" WHERE "shopId" = :shopId`,
              { shopId },
            )
          )[0].n,
        ),
      ).toBe(1);
    });

    it('S15 AS-40: a reserve is stored with its history and the next run uses it; invalid values and non-admins are refused', async () => {
      const res = await setReserve(admin, shopId, {
        reserveBps: 2500,
        reason: 'chargeback risk',
      });

      expect(res.status).toBe(200);
      expect(payoutReserveResponseSchema.parse(res.body)).toMatchObject({
        shopId,
        reserveBps: 2500,
        reason: 'chargeback risk',
        updatedBy: admin.id,
      });
      expect(
        await sql(
          t.app,
          `SELECT "previousBps", "reserveBps", "actor" FROM "PayoutReserveHistory" WHERE "shopId" = :shopId`,
          { shopId },
        ),
      ).toEqual([{ previousBps: null, reserveBps: 2500, actor: admin.id }]);
      await fund(t, shopId, 20_000);
      await t.run.run({});
      expect(await payoutOf(t, shopId)).toMatchObject({
        amountMinor: '15000',
        reserveHeldMinor: '5000',
      });

      for (const bad of [
        { reserveBps: -1, reason: 'x' },
        { reserveBps: 5001, reason: 'x' },
        { reserveBps: 12.5, reason: 'x' },
        { reserveBps: '10', reason: 'x' },
        { reason: 'x' },
        { reserveBps: 10, reason: '' },
        { reserveBps: 10, reason: 'x'.repeat(201) },
        { reserveBps: 10, reason: 'x', extra: true },
      ])
        expect((await setReserve(admin, shopId, bad)).status).toBe(400);
      expect(
        (await setReserve(owner, shopId, { reserveBps: 10, reason: 'x' }))
          .status,
      ).toBe(403);
      expect(
        (await setReserve(admin, uuidv4(), { reserveBps: 10, reason: 'x' }))
          .body.code,
      ).toBe('shop_not_found');
    });

    it('S15 AS-41: a repeated write replays, another body under the same key is 422, a missing key is 422, a refused body does not use up the key', async () => {
      const body = { reserveBps: 100, reason: 'first' };
      const one = await setReserve(admin, shopId, body, 'key-reserve-0001');
      const replay = await setReserve(admin, shopId, body, 'key-reserve-0001');
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(one.body);
      expect(
        (
          await setReserve(
            admin,
            shopId,
            { ...body, reason: 'other' },
            'key-reserve-0001',
          )
        ).body.code,
      ).toBe('idempotency_key_reuse');
      expect((await setReserve(admin, shopId, body, null)).body.code).toBe(
        'idempotency_key_required',
      );
      expect(
        (
          await setDestination(
            admin,
            shopId,
            { providerAccountId: 'acct_12345678' },
            null,
          )
        ).status,
      ).toBe(422);
      expect(
        (await cancel(admin, uuidv4(), { reason: 'x' }, null)).status,
      ).toBe(422);

      expect(
        (
          await setReserve(
            admin,
            shopId,
            { reserveBps: -1, reason: 'x' },
            'key-reserve-0002',
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await setReserve(
            admin,
            shopId,
            { reserveBps: 5, reason: 'x' },
            'key-reserve-0002',
          )
        ).status,
      ).toBe(200);

      // a request in flight: the same key is 409 with Retry-After
      const service = t.app.get(PayoutDestinationService, { strict: false });
      const original = service.set.bind(service);
      const gate = createGate();
      jest.spyOn(service, 'set').mockImplementation(async (...args) => {
        await gate.wait();
        return original(...args);
      });
      const slow = setDestination(
        admin,
        shopId,
        { providerAccountId: 'acct_SLOWREQUEST01' },
        'key-dest-000001',
      ).then((r) => r);
      await gate.reached;
      const concurrent = await setDestination(
        admin,
        shopId,
        { providerAccountId: 'acct_SLOWREQUEST01' },
        'key-dest-000001',
      );
      expect(concurrent.status).toBe(409);
      expect(concurrent.body.code).toBe('idempotency_in_flight');
      gate.open();
      expect((await slow).status).toBe(200);
      jest.restoreAllMocks();

      // after 24 hours the key is free again and the request acts
      t.clock.advance(24 * H + 60_000);
      admin = await t.newUser({ role: Role.ADMIN });
      const later = await setReserve(
        admin,
        shopId,
        { reserveBps: 300, reason: 'later' },
        'key-reserve-0001',
      );
      expect(later.status).toBe(200);
      expect(later.headers['idempotency-replayed']).toBeUndefined();
      expect(later.body.reserveBps).toBe(300);
    });

    it('S15 AS-41: a write with a revoked session is refused, an ordinary read with the same token is still answered', async () => {
      await t
        .as(admin)
        .delete(`/api/auth/sessions/${admin.sessionId}`)
        .expect(204);

      expect(
        (await setReserve(admin, shopId, { reserveBps: 10, reason: 'x' }))
          .status,
      ).toBe(401);
      expect((await get(admin, '/finance/payouts')).status).toBe(200);
      expect(await sql(t.app, `SELECT * FROM "PayoutReserve"`)).toEqual([]);
    });

    it('S15 AS-48: the 31st write in a minute is 429 with Retry-After', async () => {
      for (let i = 0; i < 30; i += 1)
        expect(
          (await setReserve(admin, shopId, { reserveBps: i, reason: `r${i}` }))
            .status,
        ).toBe(200);
      const limited = await setReserve(admin, shopId, {
        reserveBps: 99,
        reason: 'late',
      });
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(
        await sql(t.app, `SELECT "reserveBps" FROM "PayoutReserve"`),
      ).toEqual([{ reserveBps: 29 }]);
    });
  });

  describe('cancelling a payout', () => {
    it('S15 AS-42: a pending payout is cancelled with its reversal, history, event and balance, and the send job never calls the provider', async () => {
      await payoutsFor([PERIOD]);
      const p = await payoutOf(t, shopId);

      const res = await cancel(admin, p.id, { reason: 'seller asked to stop' });

      expect(res.status).toBe(200);
      expect(adminPayoutSchema.parse(res.body)).toMatchObject({
        id: p.id,
        status: 'CANCELLED',
      });
      expect(await shopBalance(t, shopId)).toBe(20_000);
      expect(
        await sql(
          t.app,
          `SELECT "kind", "reference" FROM "LedgerJournal" WHERE "reference" = :id AND "kind" = 'PAYOUT_REVERSAL'`,
          { id: p.id },
        ),
      ).toHaveLength(1);
      expect(
        await sql(
          t.app,
          `SELECT "toStatus", "actor", "reason" FROM "PayoutHistory" WHERE "payoutId" = :id ORDER BY "id"`,
          { id: p.id },
        ),
      ).toEqual([
        { toStatus: 'PENDING', actor: 'system', reason: null },
        {
          toStatus: 'CANCELLED',
          actor: admin.id,
          reason: 'seller asked to stop',
        },
      ]);
      const events = await sql<{
        payload: { payload: Record<string, unknown> };
      }>(
        t.app,
        `SELECT "payload" FROM "Outbox" WHERE "type" = 'payout.cancelled' AND "aggregateId" = :id`,
        { id: p.id },
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload.payload).toMatchObject({
        cancelledBy: admin.id,
        reason: 'seller asked to stop',
      });

      await t.transfers.send(p.id, first);
      expect(t.provider.calls).toEqual([]);
      await assertPayoutBooks(t);
    });

    it('S15 AS-43: a payout that has started or ended cannot be cancelled and stays as it was', async () => {
      const make = async () => {
        await payoutsFor([PERIOD], (await seller(t, { balance: 0 })).shopId);
        return (
          await sql<{ id: string }>(
            t.app,
            `SELECT "id" FROM "Payout" ORDER BY "createdAt" DESC LIMIT 1`,
          )
        )[0].id;
      };
      const states: Array<[string, () => Promise<string>]> = [
        [
          'SENDING',
          async () => {
            const id = await make();
            t.provider.next({ kind: 'hang' });
            void t.transfers.send(id, first);
            for (
              let i = 0;
              i < 100 && t.provider.transferCalls().length < 1;
              i += 1
            )
              await new Promise((r) => setTimeout(r, 25));
            return id;
          },
        ],
        [
          'UNKNOWN',
          async () => {
            const id = await make();
            t.provider.next({ kind: 'timeout' });
            await t.transfers.send(id, first);
            return id;
          },
        ],
        [
          'PAID',
          async () => {
            const id = await make();
            await t.transfers.send(id, first);
            return id;
          },
        ],
        [
          'FAILED',
          async () => {
            const id = await make();
            t.provider.next({ kind: 'reject', code: 'account_closed' });
            await t.transfers.send(id, first);
            return id;
          },
        ],
        [
          'CANCELLED',
          async () => {
            const id = await make();
            await t.cancellation.cancel(id, admin.id, 'first');
            return id;
          },
        ],
      ];
      for (const [status, prepare] of states) {
        const id = await prepare();
        const before = await sql(
          t.app,
          `SELECT "status", "payoutVersion" FROM "Payout" WHERE "id" = :id`,
          { id },
        );

        const res = await cancel(admin, id, { reason: 'too late' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('payout_state_conflict');
        expect(res.body.details).toEqual({ status });
        expect(
          await sql(
            t.app,
            `SELECT "status", "payoutVersion" FROM "Payout" WHERE "id" = :id`,
            { id },
          ),
        ).toEqual(before);
      }
    });

    it('S15 AS-44: a cancel against a send has exactly one winner, fifty times over, and the books stay whole', async () => {
      for (let i = 0; i < 50; i += 1) {
        await t.reset();
        t.clock.set(RUN_AT);
        const s = await seller(t, { balance: 20_000 });
        await t.run.run({});
        const p = await payoutOf(t, s.shopId);

        const [cancelled, sent] = await Promise.allSettled([
          t.cancellation.cancel(p.id, 'admin-1', 'race'),
          t.transfers.send(p.id, first),
        ]);

        const [after] = await sql<{ status: string }>(
          t.app,
          `SELECT "status" FROM "Payout" WHERE "id" = :id`,
          { id: p.id },
        );
        if (cancelled.status === 'fulfilled') {
          expect(after.status).toBe('CANCELLED');
          expect(t.provider.calls).toEqual([]);
        } else {
          expect(after.status).toBe('PAID');
          expect(t.provider.transferCalls()).toHaveLength(1);
        }
        expect(sent.status).toBe('fulfilled');
        await assertPayoutBooks(t);
      }
    }, 300_000);

    it('S15 AS-45: only an admin cancels, an unknown payout is 404, a malformed id and a missing reason are 400', async () => {
      await payoutsFor([PERIOD]);
      const p = await payoutOf(t, shopId);

      expect((await cancel(owner, p.id, { reason: 'x' })).status).toBe(403);
      expect((await cancel(null, p.id, { reason: 'x' })).status).toBe(401);
      const unknown = await cancel(admin, uuidv4(), { reason: 'x' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('payout_not_found');
      expect((await cancel(admin, 'not-a-uuid', { reason: 'x' })).status).toBe(
        400,
      );
      expect((await cancel(admin, p.id, {})).status).toBe(400);
      expect((await cancel(admin, p.id, { reason: '' })).status).toBe(400);
      expect((await payoutOf(t, shopId)).status).toBe('PENDING');
    });
  });

  describe('the operator reads', () => {
    it('S15 AS-46: the operator list filters, pages by keyset, shows internal statuses and the masked destination; bad input is 400', async () => {
      const second = await seller(t, { balance: 0 });
      await payoutsFor(['2026-09-28', PERIOD]);
      await payoutsFor([PERIOD], second.shopId);
      const rows = await sql<{ id: string }>(
        t.app,
        `SELECT "id" FROM "Payout" WHERE "shopId" = :shopId AND "periodStart" = '2026-09-28'`,
        { shopId },
      );
      t.provider.next({ kind: 'timeout' });
      await t.transfers.send(rows[0].id, first);

      const all = adminPayoutPageSchema.parse(
        (await get(admin, '/finance/payouts')).body,
      );
      expect(all.items).toHaveLength(3);
      expect(all.items.map((i) => i.status).sort()).toEqual([
        'PENDING',
        'PENDING',
        'UNKNOWN',
      ]);
      for (const item of all.items)
        expect(item.destination).toMatch(/^acct_….{3}$/);
      expect(JSON.stringify(all)).not.toMatch(/acct_[A-Za-z0-9]{8}/);

      const byStatus = adminPayoutPageSchema.parse(
        (await get(admin, '/finance/payouts?status=UNKNOWN')).body,
      );
      expect(byStatus.items.map((i) => i.id)).toEqual([rows[0].id]);
      expect(
        adminPayoutPageSchema.parse(
          (await get(admin, `/finance/payouts?shopId=${second.shopId}`)).body,
        ).items,
      ).toHaveLength(1);
      expect(
        adminPayoutPageSchema.parse(
          (await get(admin, `/finance/payouts?periodStart=${PERIOD}`)).body,
        ).items,
      ).toHaveLength(2);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = adminPayoutPageSchema.parse(
          (
            await get(
              admin,
              `/finance/payouts?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
            )
          ).body,
        );
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);

      for (const bad of [
        'status=BOGUS',
        'shopId=nope',
        'periodStart=2026-13-40',
        'limit=0',
        'limit=101',
        'cursor=junk',
      ])
        expect((await get(admin, `/finance/payouts?${bad}`)).status).toBe(400);
      expect((await get(admin, '/finance/payouts?cursor=junk')).body.code).toBe(
        'invalid_cursor',
      );
      expect((await get(owner, '/finance/payouts')).status).toBe(403);
      expect((await get(null, '/finance/payouts')).status).toBe(401);
    });

    it('S15 AS-47: the runs are listed newest first, a failed one shows its code and a resumed one completes', async () => {
      await seller(t, { balance: 20_000 });
      await seller(t, { balance: 20_000 });
      await t.run.run({ periodStart: '2026-09-28' });
      const stop = new AbortController();
      stop.abort();
      await t.run.run({ periodStart: PERIOD, signal: stop.signal });

      const first1 = payoutRunPageSchema.parse(
        (await get(admin, '/finance/payouts/runs')).body,
      );
      expect(
        first1.items.map((r) => [r.periodStart, r.status, r.failureCode]),
      ).toEqual([
        [PERIOD, 'FAILED', 'interrupted'],
        ['2026-09-28', 'COMPLETED', null],
      ]);
      expect(first1.items[1]).toMatchObject({ created: 2, existing: 0 });

      await t.run.run({ periodStart: PERIOD });
      const resumed = payoutRunPageSchema.parse(
        (await get(admin, '/finance/payouts/runs?limit=1')).body,
      );
      expect(resumed.items[0]).toMatchObject({
        periodStart: PERIOD,
        status: 'COMPLETED',
        failureCode: null,
      });
      expect(resumed.nextCursor).not.toBeNull();
      expect((await get(owner, '/finance/payouts/runs')).status).toBe(403);
    });
  });

  // Last in the file: it boots a second app, and the models are bound to the newest connection.
  it('S15 AS-36: with the limiter store down a seller read is still answered; S15 AS-48: a write is refused (fail closed) and nothing changes', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createPayoutApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
    try {
      await own.reset();
      const who = await own.newUser({ role: Role.ADMIN });
      const member = await own.newUser();
      const shop = await createShop(own.app, member);
      own.shops.set(shop.id);
      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));

      const read = await own.as(member).get(`/api/shops/${shop.id}/payouts`);
      const write = await own
        .as(who)
        .put(`/api/finance/shops/${shop.id}/payout-reserve`)
        .set('Idempotency-Key', 'k-down-000001')
        .send({ reserveBps: 10, reason: 'x' });

      expect(read.status).toBe(200);
      expect(write.status).toBe(503);
      expect(await sql(own.app, `SELECT * FROM "PayoutReserve"`)).toEqual([]);
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  }, 60_000);
});
