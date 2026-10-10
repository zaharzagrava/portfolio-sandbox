import { randomUUID } from 'node:crypto';
import { paymentSchema } from '@marketplace-sandbox/contracts';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  payableBuyer,
  type PaymentsTestApp,
} from './testing';

describe('Payments: reads, list and tenant isolation', () => {
  let t: PaymentsTestApp;

  beforeAll(async () => {
    t = await createPaymentsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const strip = (b: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = b;
    return rest;
  };

  it('S13 AS-57: the owner reads the payment; another buyer, a missing id and a non-UUID are the same 404; no credentials is 401; the secret is for the owner while customer action is pending', async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    const stranger = await t.newUser();

    const own = await t.as(buyer.user).get(`/api/payments/${id}`);
    expect(own.status).toBe(200);
    expect(paymentSchema.parse(own.body)).toMatchObject({
      id,
      status: 'PENDING',
      clientSecret: null,
    });

    const other = await t.as(stranger).get(`/api/payments/${id}`);
    const missing = await t.as(stranger).get(`/api/payments/${randomUUID()}`);
    expect(other.status).toBe(404);
    expect(other.body.code ?? other.body.type).toBeDefined();
    expect(JSON.stringify(other.body)).toContain('payment_not_found');
    expect(missing.status).toBe(404);
    expect(strip(other.body)).toEqual(strip(missing.body));

    const malformed = await t.as(buyer.user).get('/api/payments/not-a-uuid');
    expect(malformed.status).toBe(404);
    expect(JSON.stringify(malformed.body)).toContain('payment_not_found');

    const anonymous = await t.http().get(`/api/payments/${id}`);
    expect(anonymous.status).toBe(401);

    t.provider.script('create', {
      kind: 'ok',
      status: 'requires_action',
      overrides: { client_secret: 'pi_secret_3ds' },
    });
    await deliverCharge(t, id);
    const owner = await t.as(buyer.user).get(`/api/payments/${id}`);
    expect(owner.body).toMatchObject({
      requiresAction: true,
      clientSecret: 'pi_secret_3ds',
    });
    const peer = await t.as(stranger).get(`/api/payments/${id}`);
    expect(peer.status).toBe(404);
    expect(JSON.stringify(peer.body)).not.toContain('pi_secret_3ds');
  });
});
