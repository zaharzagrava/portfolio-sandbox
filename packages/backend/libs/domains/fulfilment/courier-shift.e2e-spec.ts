import {
  courierSchema,
  courierSelfSchema,
} from '@marketplace-sandbox/contracts';
import {
  createDeliveryApp,
  type DeliveryTestApp,
} from './testing/delivery-fixtures';

describe('Courier profile, shift and self view', () => {
  let t: DeliveryTestApp;

  beforeAll(async () => {
    t = await createDeliveryApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const register = (user: Parameters<typeof t.as>[0], body: unknown) =>
    t
      .as(user)
      .post('/api/couriers/me')
      .send(body as object);
  const shift = (user: Parameters<typeof t.as>[0], body: unknown) =>
    t
      .as(user)
      .put('/api/couriers/me/availability')
      .send(body as object);
  const self = (user: Parameters<typeof t.as>[0]) =>
    t.as(user).get('/api/couriers/me');

  describe('US1 - registration (AS-01)', () => {
    it('S20 AS-01: a first registration is 201 OFFLINE with one row; a change of city and vehicle while OFFLINE is 200', async () => {
      const user = await t.newUser();

      const created = await register(user, {
        city: 'berlin',
        vehicle: 'bike',
      }).expect(201);
      expect(courierSchema.parse(created.body)).toEqual({
        id: user.id,
        city: 'berlin',
        vehicle: 'bike',
        status: 'OFFLINE',
      });
      expect(await t.courierRows()).toBe(1);

      const changed = await register(user, {
        city: 'hamburg',
        vehicle: 'car',
      }).expect(200);
      expect(courierSchema.parse(changed.body)).toMatchObject({
        city: 'hamburg',
        vehicle: 'car',
      });
      expect(await t.courierRow(user.id)).toMatchObject({
        city: 'hamburg',
        vehicle: 'car',
        status: 'OFFLINE',
      });
      expect(await t.courierRows()).toBe(1);
    });

    it('S20 AS-01: a BUSY courier cannot change city or vehicle: 409 courier_busy and nothing changes; the same values are 200', async () => {
      const c = await t.newCourier({ city: 'berlin' });
      await t.makeBusy(c);

      const res = await register(c.user, {
        city: 'hamburg',
        vehicle: 'bike',
      }).expect(409);
      expect(res.body.code).toBe('courier_busy');
      await register(c.user, { city: 'berlin', vehicle: 'car' }).expect(409);
      expect(await t.courierRow(c.user.id)).toMatchObject({
        city: 'berlin',
        vehicle: 'bike',
        status: 'BUSY',
      });

      await register(c.user, { city: 'berlin', vehicle: 'bike' }).expect(200);
    });

    it('S20 AS-01: a courier holding a live offer cannot change city: 409 courier_busy and nothing changes', async () => {
      const c = await t.newCourier({ city: 'berlin', status: 'AVAILABLE' });
      await t.giveOffer(c);

      const res = await register(c.user, {
        city: 'hamburg',
        vehicle: 'bike',
      }).expect(409);
      expect(res.body.code).toBe('courier_busy');
      expect(await t.courierRow(c.user.id)).toMatchObject({
        city: 'berlin',
        vehicle: 'bike',
      });
    });

    it.each([
      ['city missing', { vehicle: 'bike' }, 'city'],
      ['city with capitals', { city: 'Berlin', vehicle: 'bike' }, 'city'],
      ['city one character', { city: 'b', vehicle: 'bike' }, 'city'],
      ['city 41 characters', { city: 'a'.repeat(41), vehicle: 'bike' }, 'city'],
      ['city with a space', { city: 'new york', vehicle: 'bike' }, 'city'],
      ['city not text', { city: 7, vehicle: 'bike' }, 'city'],
      ['vehicle missing', { city: 'berlin' }, 'vehicle'],
      ['vehicle unknown', { city: 'berlin', vehicle: 'jet' }, 'vehicle'],
      [
        'unknown field',
        { city: 'berlin', vehicle: 'bike', status: 'AVAILABLE' },
        'status',
      ],
    ])(
      'S20 AS-01: %s is 400 validation_failed naming the field and stores nothing',
      async (_name, body, field) => {
        const user = await t.newUser();
        const res = await register(user, body).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(JSON.stringify(res.body)).toContain(field);
        expect(await t.courierRows()).toBe(0);
      },
    );

    it('S20 AS-01: no credentials is 401', async () => {
      await t
        .http()
        .post('/api/couriers/me')
        .send({ city: 'berlin', vehicle: 'bike' })
        .expect(401);
      expect(await t.courierRows()).toBe(0);
    });
  });

  describe('US1 - shift (AS-02)', () => {
    it('S20 AS-02: available is 200 AVAILABLE with the stored status; repeating it is 200 and changes nothing; unavailable is 200 OFFLINE', async () => {
      const c = await t.newCourier();

      const on = await shift(c.user, { available: true }).expect(200);
      expect(courierSchema.parse(on.body)).toMatchObject({
        id: c.user.id,
        status: 'AVAILABLE',
      });
      expect((await t.courierRow(c.user.id))?.status).toBe('AVAILABLE');

      const again = await shift(c.user, { available: true }).expect(200);
      expect(again.body).toMatchObject({ status: 'AVAILABLE' });
      expect((await t.courierRow(c.user.id))?.status).toBe('AVAILABLE');

      const off = await shift(c.user, { available: false }).expect(200);
      expect(off.body).toMatchObject({ status: 'OFFLINE' });
      expect((await t.courierRow(c.user.id))?.status).toBe('OFFLINE');
    });

    it('S20 AS-02: an AVAILABLE courier with a position is searchable; going OFFLINE removes it; going on shift again restores it', async () => {
      const c = await t.newCourier({ status: 'AVAILABLE' });
      await t.ping(c.user, [t.point()]).expect(202);
      expect(await t.searchable(c.city)).toEqual([c.user.id]);

      await shift(c.user, { available: false }).expect(200);
      expect(await t.searchable(c.city)).toEqual([]);

      await shift(c.user, { available: true }).expect(200);
      expect(await t.searchable(c.city)).toEqual([c.user.id]);
    });

    it('S20 AS-02: an AVAILABLE courier that never reported a position is not searchable', async () => {
      const c = await t.newCourier({ status: 'AVAILABLE' });
      expect(await t.searchable(c.city)).toEqual([]);
    });

    it('S20 AS-02: a BUSY courier gets 409 courier_busy in both directions and keeps its status', async () => {
      const c = await t.newCourier({ status: 'AVAILABLE' });
      await t.makeBusy(c);

      for (const available of [true, false]) {
        const res = await shift(c.user, { available }).expect(409);
        expect(res.body.code).toBe('courier_busy');
      }
      expect((await t.courierRow(c.user.id))?.status).toBe('BUSY');
    });

    it('S20 AS-02: a user without a courier profile gets 403 courier_profile_required', async () => {
      const user = await t.newUser();
      const res = await shift(user, { available: true }).expect(403);
      expect(res.body.code).toBe('courier_profile_required');
    });

    it.each([
      ['available missing', {}],
      ['available a string', { available: 'yes' }],
      ['available a number', { available: 1 }],
      ['unknown field', { available: true, status: 'BUSY' }],
    ])(
      'S20 AS-02: %s is 400 validation_failed and the status is unchanged',
      async (_name, body) => {
        const c = await t.newCourier();
        const res = await shift(c.user, body).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect((await t.courierRow(c.user.id))?.status).toBe('OFFLINE');
      },
    );

    it('S20 AS-02: no credentials is 401', async () => {
      await t
        .http()
        .put('/api/couriers/me/availability')
        .send({ available: true })
        .expect(401);
    });
  });

  describe('US1 - self view (AS-13)', () => {
    it('S20 AS-13: the profile alone, without an offer or a delivery', async () => {
      const c = await t.newCourier({ status: 'AVAILABLE' });
      const res = await self(c.user).expect(200);
      const body = courierSelfSchema.parse(res.body);
      expect(body).toEqual({
        id: c.user.id,
        city: c.city,
        vehicle: 'bike',
        status: 'AVAILABLE',
      });
    });

    it('S20 AS-13: the live offer is present while live and gone once it expired', async () => {
      const c = await t.newCourier({ status: 'AVAILABLE' });
      const deliveryId = await t.giveOffer(c);

      const live = courierSelfSchema.parse(
        (await self(c.user).expect(200)).body,
      );
      expect(live.currentOffer).toMatchObject({
        deliveryId,
        feeMinor: 499,
        currency: 'EUR',
        pickup: { lat: 52.5219, lng: 13.4132 },
        dropoff: { lat: 52.5096, lng: 13.3759 },
        expiresAt: new Date(t.clock.now().getTime() + 15_000).toISOString(),
      });
      expect(live.activeDelivery).toBeUndefined();

      t.clock.advance(15_001);
      const expired = courierSelfSchema.parse(
        (await self(c.user).expect(200)).body,
      );
      expect(expired.currentOffer).toBeUndefined();
    });

    it('S20 AS-13: an ASSIGNED delivery is shown as the active delivery', async () => {
      const c = await t.newCourier({ status: 'AVAILABLE' });
      const deliveryId = await t.makeBusy(c);

      const body = courierSelfSchema.parse(
        (await self(c.user).expect(200)).body,
      );
      expect(body).toMatchObject({
        status: 'BUSY',
        activeDelivery: { deliveryId, status: 'ASSIGNED' },
      });
      expect(body.currentOffer).toBeUndefined();
    });

    it('S20 AS-13: a user without a profile gets 403 courier_profile_required; no credentials is 401', async () => {
      const user = await t.newUser();
      const res = await self(user).expect(403);
      expect(res.body.code).toBe('courier_profile_required');
      await t.http().get('/api/couriers/me').expect(401);
    });
  });
});
