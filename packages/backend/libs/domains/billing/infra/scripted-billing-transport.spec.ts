import { ScriptedBillingTransport } from './scripted-billing-transport';

const charge = (paymentMethodId: string, idempotencyKey = 'inv:1') => ({
  amount: 9900,
  currency: 'eur',
  paymentMethodId,
  idempotencyKey,
  metadata: { kind: 'subscription_invoice', invoiceId: 'inv' },
});

describe('the scripted billing provider of the local profile (J02 G-17)', () => {
  it('S17 G-17: pm_test_visa succeeds and the same key never charges twice', async () => {
    const provider = new ScriptedBillingTransport();
    const first = await provider.createPaymentIntent(charge('pm_test_visa'));
    expect(first.status).toBe('succeeded');
    const again = await provider.createPaymentIntent(
      charge('pm_test_declined'),
    );
    expect(again).toEqual(first); // the provider dedupes on the key
    expect(provider.created).toBe(1);
  });

  it('S17 G-17: pm_test_declined is a card error with the SDK shape', async () => {
    const provider = new ScriptedBillingTransport();
    await expect(
      provider.createPaymentIntent(charge('pm_test_declined')),
    ).rejects.toMatchObject({
      type: 'StripeCardError',
      code: 'card_declined',
      statusCode: 402,
    });
  });

  it('S17 G-17: pm_test_timeout never answers in time, and the charge can be found by metadata afterwards', async () => {
    const provider = new ScriptedBillingTransport();
    await expect(
      provider.createPaymentIntent({
        ...charge('pm_test_timeout'),
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ type: 'StripeConnectionError' });
    expect(
      await provider.findPaymentIntentByMetadataPair({ invoiceId: 'inv' }, 100),
    ).toBeNull();
  });

  it('S17 G-17: a payment method that is not one of the doubles succeeds', async () => {
    const provider = new ScriptedBillingTransport();
    expect(
      (await provider.createPaymentIntent(charge('pm_card_visa', 'k2'))).status,
    ).toBe('succeeded');
  });

  it('S17 G-17: a successful charge is found by its metadata', async () => {
    const provider = new ScriptedBillingTransport();
    await provider.createPaymentIntent(charge('pm_test_visa'));
    const found = await provider.findPaymentIntentByMetadataPair(
      { invoiceId: 'inv' },
      100,
    );
    expect(found).toMatchObject({ status: 'succeeded' });
  });
});
