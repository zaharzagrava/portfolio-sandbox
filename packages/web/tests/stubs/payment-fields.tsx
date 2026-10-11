'use client';

import { useEffect, type ReactElement } from 'react';

/**
 * Hosted-field stand-in for jsdom (W03 T003, gaps T5). The real card fields live in the provider's frames; this renders
 * three labelled inputs whose values are never read by the page, plus a controller the test uses to report what the
 * provider would report: `complete`, `incomplete`, an error under the field, and a tokenisation outcome.
 *
 * Contract it imitates (what `PaymentFields` hands to the pay form, see `contracts/web-modules.md` / T058):
 *   - `onChange({complete, error?})` whenever the provider's completeness or error text changes;
 *   - `tokenize(): Promise<{ok: true, paymentMethodId} | {ok: false, error}>` via the `ref`-like `register` callback.
 */
export type StubFieldState = { complete: boolean; error?: string };
export type StubTokenResult = { ok: true; paymentMethodId: string } | { ok: false; error: string };

export type StubPaymentFieldsController = {
  complete: () => void;
  incomplete: () => void;
  error: (message: string) => void;
  /** What the next `tokenize()` resolves with. Default: `{ok: true, paymentMethodId: 'pm_stub_card'}`. */
  nextToken: (result: StubTokenResult) => void;
  tokenizeCalls: () => number;
};

type Props = {
  onChange: (state: StubFieldState) => void;
  register?: (tokenize: () => Promise<StubTokenResult>) => void;
  /** Receives the controller on mount; keep it in a variable of the test. */
  controllerRef?: (controller: StubPaymentFieldsController) => void;
};

export function StubPaymentFields({ onChange, register, controllerRef }: Props): ReactElement {
  useEffect(() => {
    let token: StubTokenResult = { ok: true, paymentMethodId: 'pm_stub_card' };
    let calls = 0;
    register?.(async () => {
      calls += 1;
      return token;
    });
    controllerRef?.({
      complete: () => onChange({ complete: true }),
      incomplete: () => onChange({ complete: false }),
      error: (message) => onChange({ complete: false, error: message }),
      nextToken: (result) => {
        token = result;
      },
      tokenizeCalls: () => calls,
    });
    // The controller is created once per mount on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <fieldset>
      <legend>Card details</legend>
      <label>
        Card number
        <input aria-label="Card number" autoComplete="off" readOnly />
      </label>
      <label>
        Expiry date
        <input aria-label="Expiry date" autoComplete="off" readOnly />
      </label>
      <label>
        Security code
        <input aria-label="Security code" autoComplete="off" readOnly />
      </label>
    </fieldset>
  );
}
