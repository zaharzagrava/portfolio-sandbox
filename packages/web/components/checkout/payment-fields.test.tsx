import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmPaymentAction, PaymentFields, type FieldState, type TokenResult } from './payment-fields';

afterEach(() => vi.unstubAllEnvs());

function mount() {
  const changes: FieldState[] = [];
  let tokenize: (() => Promise<TokenResult>) | undefined;
  render(<PaymentFields onChange={(state) => changes.push(state)} register={(fn) => (tokenize = fn)} />);
  return { changes, tokenize: () => tokenize };
}

describe('Payment fields adapter', () => {
  it('W03 AS-37: with the sandbox flag outside production the test-card picker replaces the provider fields', async () => {
    vi.stubEnv('NEXT_PUBLIC_PAYMENTS_SANDBOX', 'true');
    const { changes, tokenize } = mount();
    expect(await screen.findByRole('group', { name: 'Card details' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Visa test card/ })).toBeChecked();
    expect(changes.at(-1)).toEqual({ complete: true });
    expect(await tokenize()?.()).toEqual({ ok: true, paymentMethodId: 'pm_card_visa' });
    // No card input exists in the picker: nothing to type, nothing for the page to read.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('W03 AS-37: the sandbox flag is ignored in a production build (no picker; the provider fields take its place)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PAYMENTS_SANDBOX', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY', '');
    const { changes } = mount();
    expect(await screen.findByText('Card number')).toBeInTheDocument();
    expect(screen.getByText('Expiry date')).toBeInTheDocument();
    expect(screen.getByText('Security code')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    // Without a publishable key the provider cannot load: the buyer is told, and Pay stays disabled.
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ complete: false, error: "Card payments aren't available right now. Try again later." }));
  });

  it('W03 AS-37: without the flag the provider fields are used', async () => {
    vi.stubEnv('NEXT_PUBLIC_PAYMENTS_SANDBOX', '');
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY', '');
    mount();
    expect(await screen.findByText('Card number')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('W03 AS-40: in the sandbox the confirmation frame is a no-op that succeeds, and the provider script is not loaded', async () => {
    vi.stubEnv('NEXT_PUBLIC_PAYMENTS_SANDBOX', 'true');
    expect(await confirmPaymentAction('pi_secret_x')).toEqual({ ok: true });
  });

  it('W03 AS-40: without a publishable key the bank frame cannot open and counts as abandoned (the buyer can retry)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PAYMENTS_SANDBOX', '');
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY', '');
    expect(await confirmPaymentAction('pi_secret_x')).toEqual({ ok: false, abandoned: true });
  });
});
