import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getModelToken } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { UserModel as User } from '@app/domains/identity';
import { issueSession } from '@app/test/seeds/session.fixture';
import { ShopModel as Shop } from '@app/domains/tenancy';
import LaunchEvent from './infra/models/launch-event.model';
import Booking from './infra/models/booking.model';
import { LaunchEventsModule } from './launch-events.module';
import { SeatHoldService } from './application/seat-hold.service';
import { WaitingRoomService } from './application/waiting-room.service';

/** SD-21 against real Postgres + Redis + DynamoDB Local. */
describe('Launch event booking (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let holds: SeatHoldService;
  let room: WaitingRoomService;
  let event: LaunchEvent;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [LaunchEventsModule, CacheModule, RateLimitModule, SeedsModule],
      { stores: ['redis', 'dynamo'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    holds = app.get(SeatHoldService);
    room = app.get(WaitingRoomService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app
      .get<typeof Booking>(getModelToken(Booking))
      .destroy({ where: {} });
    await app
      .get<typeof LaunchEvent>(getModelToken(LaunchEvent))
      .destroy({ where: {} });
    await seeds.clean();
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Apple', slug: `apple-${v4().slice(0, 8)}` });
    event = await app
      .get<typeof LaunchEvent>(getModelToken(LaunchEvent))
      .create({
        shopId: shop.id,
        title: 'iPhone 18 Keynote Live',
        venue: 'Berlin flagship',
        startsAt: new Date(Date.now() + 86_400_000),
        salesOpenAt: new Date(Date.now() - 1_000),
        seatCount: 800,
        perUserLimit: 2,
      });
  });

  const users = (n: number) =>
    app.get<typeof User>(getModelToken(User)).bulkCreate(
      Array.from({ length: n }, () => ({ email: `u-${v4()}@mail.com` })),
      { returning: true },
    );

  it('100 people click the same seat at once → exactly one hold, 99 × SEAT_TAKEN', async () => {
    const people = await users(100);
    const results = await inParallel(100, (i) =>
      holds.hold(event, people[i].id, [42]),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' &&
          (r.reason as { status?: number }).status === 409,
      ),
    ).toHaveLength(99);
  });

  it('multi-seat holds are all-or-nothing: a conflict on one seat rolls back the others', async () => {
    const [a, b] = await users(2);
    await holds.hold(event, a.id, [10]);

    await expect(holds.hold(event, b.id, [9, 10])).rejects.toMatchObject({
      status: 409,
    });
    // Seat 9 was rolled back - someone else can take it.
    await expect(holds.hold(event, a.id, [9])).resolves.toMatchObject({
      seats: [9],
    });
  });

  it('an expired/released hold frees the seat; confirm is idempotent and survives expiry jobs', async () => {
    const [a, b] = await users(2);
    const first = await holds.hold(event, a.id, [1]);
    await holds.release(first.holdId); // what the expiry job does

    const second = await holds.hold(event, b.id, [1]);
    const booked = await holds.confirm(second.holdId, b.id);
    expect(booked).toHaveLength(1);
    expect(await holds.confirm(second.holdId, b.id)).toHaveLength(1); // retry
    expect(await holds.release(second.holdId)).toBe(false); // expiry after confirm: no-op

    const bitmap = Buffer.from(await holds.seatMap(event.id), 'base64');
    expect((bitmap[0] >> (7 - 1)) & 1).toBe(1); // seat 1 shown as taken
  });

  it('per-person limit', async () => {
    const [a] = await users(1);
    await expect(holds.hold(event, a.id, [1, 2, 3])).rejects.toMatchObject({
      status: 422,
    });
    await expect(holds.hold(event, a.id, [1, 2])).resolves.toBeDefined();
  });

  it('waiting room: joins are queued, admission happens at the configured rate, tokens are bound to user + event', async () => {
    const people = await users(30);
    const tickets = await Promise.all(
      people.map((p) => room.join(event.id, p.id, event.salesOpenAt)),
    );
    expect(tickets.every((t) => !t.admitted && t.position! >= 1)).toBe(true);

    expect(await room.admit(event.id, 10)).toBeGreaterThanOrEqual(10);
    const statuses = await Promise.all(
      tickets.map((t) => room.status(event.id, t.ticket)),
    );
    const admitted = statuses.filter((s) => s.admitted);
    expect(admitted.length).toBeGreaterThanOrEqual(10);

    const holder =
      people[
        tickets.findIndex((t) => admitted.some((a) => a.ticket === t.ticket))
      ];
    const token = admitted.find(
      (a) => a.ticket === tickets[people.indexOf(holder)].ticket,
    )!.admissionToken;
    await expect(
      room.assertAdmitted(event.id, holder.id, token),
    ).resolves.toBeUndefined();
    await expect(
      room.assertAdmitted(
        event.id,
        people.find((p) => p !== holder)!.id,
        token,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      room.assertAdmitted(v4(), holder.id, token),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('HTTP: holding without an admission token is rejected before touching any store', async () => {
    const [a] = await users(1);
    const auth = { Authorization: (await issueSession(app, a)).bearer };
    await request(app.getHttpServer())
      .post(`/api/launch-events/${event.id}/holds`)
      .set(auth)
      .send({ seats: [5] })
      .expect(403);
  });
});
