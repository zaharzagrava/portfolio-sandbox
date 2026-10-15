/**
 * The provider's answer to a transfer is data to be checked, not a fact (S15 FR-020, AS-25). It has to name a
 * reference and agree with what was asked on amount, currency and destination; anything else is not a success.
 */
export interface ExpectedTransfer {
  amountMinor: number;
  currency: string;
  destination: string;
}

export type ProviderMismatchKind =
  'amount' | 'currency' | 'destination' | 'missing_transfer';

export type AnswerCheck =
  { ok: true; transferRef: string } | { ok: false; kind: ProviderMismatchKind };

const bad = (kind: ProviderMismatchKind): AnswerCheck => ({ ok: false, kind });

export function validateProviderAnswer(
  expected: ExpectedTransfer,
  answer: unknown,
): AnswerCheck {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer))
    return bad('missing_transfer');
  const body = answer as Record<string, unknown>;
  if (typeof body.id !== 'string' || body.id.length === 0)
    return bad('missing_transfer');
  if (body.amount !== expected.amountMinor) return bad('amount');
  if (
    typeof body.currency !== 'string' ||
    body.currency.toUpperCase() !== expected.currency.toUpperCase()
  )
    return bad('currency');
  if (body.destination !== expected.destination) return bad('destination');
  return { ok: true, transferRef: body.id };
}
