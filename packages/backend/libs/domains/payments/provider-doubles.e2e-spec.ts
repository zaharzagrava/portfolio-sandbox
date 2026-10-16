import { ConfigRuleSet } from '@app/common/config/config-rules';
import {
  providerDoublesRule,
  paymentsConfigKeys,
} from '@app/common/config/payments-config';
import { classifyCharge, classifyLookup } from './domain/provider-outcome';
import { validateProviderAnswer } from './domain/provider-answer';
import {
  ScriptedPaymentProvider,
  SLOW_CHARGE_MS,
  type ScriptedTimer,
} from './infra/scripted-payment-provider';
import { ScriptedPayoutProvider } from './infra/scripted-payout-provider';

/** A timer the spec drives by hand: `sleep` settles only when the spec advances the time (no real wait). */
class ManualTimer implements ScriptedTimer {
  private nowMs = 1_000_000;
  private readonly waiters: Array<{ at: number; resolve: () => void }> = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ at: this.nowMs + ms, resolve });
    });
  }

  advance(ms: number): void {
    this.nowMs += ms;
    for (const w of this.waiters.filter((x) => x.at <= this.nowMs)) w.resolve();
  }
}

const charge = (method: string, orderId: string, currency = 'EUR') => ({
  paymentId: `pay-${orderId}`,
  orderId,
  amountMinor: 2_500,
  currency,
  paymentMethodToken: method,
  referenceKey: orderId,
});
const expected = (orderId: string, currency = 'EUR') => ({
  amountMinor: 2_500,
  currency,
  orderId,
});
const transfer = (destination: string, payoutId: string) => ({
  payoutId,
  amountMinor: 9_000,
  currency: 'EUR',
  destination,
});

describe('Provider doubles (J01 G-17)', () => {
  describe('payment provider', () => {
    let timer: ManualTimer;
    let provider: ScriptedPaymentProvider;
    beforeEach(() => {
      timer = new ManualTimer();
      provider = new ScriptedPaymentProvider(timer);
    });

    it('J01 G-17: pm_test_visa succeeds and the lookup agrees', async () => {
      const response = await provider.createIntent(
        charge('pm_test_visa', 'o1'),
      );
      expect(classifyCharge(response, expected('o1'))).toEqual({
        kind: 'succeeded',
        providerRef: 'pi_scripted_o1',
      });
      expect(
        classifyLookup(
          await provider.retrieveIntent('pi_scripted_o1'),
          expected('o1'),
        ),
      ).toEqual({ kind: 'succeeded', providerRef: 'pi_scripted_o1' });
      expect(
        classifyLookup(
          await provider.findIntentByReference('o1'),
          expected('o1'),
        ),
      ).toEqual({ kind: 'succeeded', providerRef: 'pi_scripted_o1' });
    });

    it('J01 G-17: pm_test_declined is a definite decline (the failure path of S13.R-14) and the lookup finds no success', async () => {
      const response = await provider.createIntent(
        charge('pm_test_declined', 'o2'),
      );
      expect(classifyCharge(response, expected('o2'))).toEqual({
        kind: 'declined',
        code: 'card_declined',
      });
      expect(
        classifyLookup(
          await provider.findIntentByReference('o2'),
          expected('o2'),
        ),
      ).toEqual({ kind: 'not_found' });
    });

    it('J01 G-17: pm_test_slow answers after 8 s on the timer and the lookup is pending until then, succeeded after', async () => {
      expect(SLOW_CHARGE_MS).toBe(8_000);
      let answered = false;
      const pending = provider
        .createIntent(charge('pm_test_slow', 'o3'))
        .then((r) => {
          answered = true;
          return r;
        });
      await Promise.resolve();
      timer.advance(SLOW_CHARGE_MS - 1);
      await Promise.resolve();
      expect(answered).toBe(false);
      expect(
        classifyLookup(
          await provider.retrieveIntent('pi_scripted_o3'),
          expected('o3'),
        ),
      ).toEqual({ kind: 'pending' });

      timer.advance(1);
      const response = await pending;
      expect(answered).toBe(true);
      expect(classifyCharge(response, expected('o3'))).toEqual({
        kind: 'succeeded',
        providerRef: 'pi_scripted_o3',
      });
      expect(
        classifyLookup(
          await provider.retrieveIntent('pi_scripted_o3'),
          expected('o3'),
        ),
      ).toEqual({ kind: 'succeeded', providerRef: 'pi_scripted_o3' });
    });

    it('J01 G-17: pm_test_timeout gives no answer (the unknown-outcome path of S13.R-15) and the lookup finds nothing', async () => {
      const response = await provider.createIntent(
        charge('pm_test_timeout', 'o4'),
      );
      expect(classifyCharge(response, expected('o4'))).toEqual({
        kind: 'ambiguous',
        reason: 'timeout',
      });
      expect(
        classifyLookup(
          await provider.findIntentByReference('o4'),
          expected('o4'),
        ),
      ).toEqual({ kind: 'not_found' });
    });

    it('J01 G-17: an unknown payment method id behaves as ok', async () => {
      const response = await provider.createIntent(
        charge('pm_card_visa', 'o5'),
      );
      expect(classifyCharge(response, expected('o5'))).toEqual({
        kind: 'succeeded',
        providerRef: 'pi_scripted_o5',
      });
    });

    it('J01 G-17: the charge uses the order currency, not a fixed one', async () => {
      const response = await provider.createIntent(
        charge('pm_test_visa', 'o6', 'GBP'),
      );
      expect(response).toMatchObject({
        kind: 'intent',
        intent: { currency: 'gbp', amountMinor: 2_500 },
      });
      expect(classifyCharge(response, expected('o6', 'GBP')).kind).toBe(
        'succeeded',
      );
      expect(classifyCharge(response, expected('o6', 'EUR')).kind).toBe(
        'invalid',
      );
    });

    it('J01 G-17: a refund of a scripted charge succeeds and is listed', async () => {
      await provider.createIntent(charge('pm_test_visa', 'o7'));
      const refund = await provider.createRefund(
        'pi_scripted_o7',
        'refund:pay-o7',
      );
      expect(refund).toMatchObject({
        kind: 'refund',
        refund: { status: 'succeeded' },
      });
      expect(await provider.findRefunds('pi_scripted_o7')).toMatchObject({
        kind: 'refunds',
        refunds: [{ status: 'succeeded' }],
      });
    });
  });

  describe('payout provider', () => {
    let provider: ScriptedPayoutProvider;
    beforeEach(() => {
      provider = new ScriptedPayoutProvider();
    });

    it('J01 G-17: acct_test_ok accepts the transfer with an answer that validates, once per payout, and the lookup finds it', async () => {
      const request = transfer('acct_test_ok', 'p1');
      const first = await provider.transfer(request);
      const again = await provider.transfer(request);
      expect(first).toEqual(again);
      if (first.kind !== 'answered') throw new Error('expected an answer');
      expect(
        validateProviderAnswer(
          { amountMinor: 9_000, currency: 'EUR', destination: 'acct_test_ok' },
          first.answer,
        ),
      ).toEqual({ ok: true, transferRef: 'tr_scripted_p1' });
      expect(await provider.lookupByReference('p1')).toEqual({
        kind: 'found',
        answer: first.answer,
        reversed: false,
      });
    });

    it('J01 G-17: acct_test_reject is a definite rejection and the lookup says so', async () => {
      expect(
        await provider.transfer(transfer('acct_test_reject', 'p2')),
      ).toEqual({ kind: 'rejected', code: 'account_invalid' });
      expect(await provider.lookupByReference('p2')).toEqual({
        kind: 'found_rejected',
        code: 'account_invalid',
      });
    });

    it('J01 G-17: acct_test_timeout gives no answer and the lookup finds no transfer', async () => {
      expect(
        await provider.transfer(transfer('acct_test_timeout', 'p3')),
      ).toEqual({ kind: 'unknown' });
      expect(await provider.lookupByReference('p3')).toEqual({
        kind: 'not_found',
      });
    });

    it('J01 G-17: an unknown account id behaves as ok', async () => {
      const outcome = await provider.transfer(transfer('acct_1Abc', 'p4'));
      expect(outcome.kind).toBe('answered');
    });
  });

  describe('configuration', () => {
    const check = (values: Record<string, unknown>, production: boolean) => {
      const set = new ConfigRuleSet();
      set.register({
        owner: 'payments',
        keys: ['provider_doubles'],
        validate: providerDoublesRule,
      });
      return set.validate(values, { production });
    };

    it('J01 G-17: PROVIDER_DOUBLES=enabled is refused in production, naming the setting', () => {
      expect(check({ provider_doubles: 'enabled' }, true)).toEqual([
        '[payments] provider_doubles must not be enabled in production',
      ]);
    });

    it('J01 G-17: PROVIDER_DOUBLES=enabled is accepted outside production and unset is accepted in production', () => {
      expect(check({ provider_doubles: 'enabled' }, false)).toEqual([]);
      expect(check({}, true)).toEqual([]);
      expect(check({ provider_doubles: '' }, true)).toEqual([]);
    });

    it('J01 G-17: only the value "enabled" is valid for the setting', () => {
      const { verify } = (
        paymentsConfigKeys as unknown as Record<
          string,
          { verify: { validate(v: unknown): { error?: unknown } } }
        >
      ).provider_doubles;
      expect(verify.validate('enabled').error).toBeUndefined();
      expect(verify.validate('').error).toBeUndefined();
      expect(verify.validate('yes').error).toBeDefined();
    });
  });
});
