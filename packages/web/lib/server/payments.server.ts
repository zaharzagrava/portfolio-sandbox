import 'server-only';
import { paymentSchema } from '@marketplace-sandbox/contracts';
import { isUuid, readAsMember } from '@/lib/server/member-read.server';
import type { ReadResult } from '@/lib/server/read.server';
import type { PaymentSummary } from '@/lib/api/payments';

/**
 * Server read of one payment as the signed-in member (through the BFF forwarder). The provider `clientSecret` is dropped
 * before the value leaves this function, so it cannot reach props, the RSC payload or a cache (W03 AS-72).
 */
export async function getPaymentSummary(paymentId: string): Promise<ReadResult<PaymentSummary>> {
  if (!isUuid(paymentId)) return { ok: false, status: 404, code: 'payment_not_found' };
  const result = await readAsMember(`/api/bff/f/payments/${paymentId}`, paymentSchema);
  if (!result.ok) return result;
  const { clientSecret: _secret, ...summary } = result.data;
  void _secret;
  return { ok: true, data: summary };
}
