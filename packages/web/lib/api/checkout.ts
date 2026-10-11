import { checkoutRequestSchema, checkoutResponseSchema, type CheckoutResponse } from '@marketplace-sandbox/contracts';

/**
 * `POST /checkout` from the server (W03 FR-020..FR-022; called by `lib/server/checkout.server.ts` inside the order server
 * function). Not a browser module: it takes the forwarded cookie and CSRF headers as input and never reads them itself.
 * The order id is read from the `202` body; `Location` is ignored. `Idempotency-Key` is mandatory.
 */

export type PostCheckoutInput = {
  /** Origin of the BFF (server-side address); the path is the forwarder's `/api/bff/f/checkout`. */
  baseUrl: string;
  /** One UUID per attempt, see `lib/checkout/attempt.ts`. */
  key: string;
  expectedTotalMinor?: number;
  /** Added only if `checkoutRequestSchema` declares `refCode` (S10 H4). */
  refCode?: string | null;
  /** `cookie` (session + CSRF) and `X-CSRF-Token`, supplied by the server module. */
  headers: Record<string, string>;
  timeoutMs?: number;
};

export type CheckoutSuccess = { ok: true; orderId: string; replayed: boolean; response: CheckoutResponse };
export type CheckoutFailure = {
  ok: false;
  /** HTTP status; `0` for a network failure or a timeout; `502` + `invalid_response` for an unusable `202`. */
  status: number;
  code?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  /** A 4xx `detail` that is a plain string (FR-082); never set for a 5xx. */
  detail?: string;
  /** The parsed JSON body of a 4xx problem, for `parseCheckoutExtras`. Never set for a 5xx. */
  body?: Record<string, unknown>;
};
export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

type SchemaLike = { shape: Record<string, unknown> };

/** The request body: `refCode` only when the schema declares it and a code is present. */
export function buildCheckoutBody(
  input: { expectedTotalMinor?: number; refCode?: string | null },
  schema: SchemaLike = checkoutRequestSchema,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.expectedTotalMinor !== undefined) body.expectedTotalMinor = input.expectedTotalMinor;
  if (input.refCode && 'refCode' in schema.shape) body.refCode = input.refCode;
  return body;
}

export async function postCheckout(input: PostCheckoutInput): Promise<CheckoutResult> {
  if (!input.key) throw new Error('idempotency_key_required: POST /checkout is never sent without an Idempotency-Key');

  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}/api/bff/f/checkout`, {
      method: 'POST',
      headers: { ...input.headers, accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': input.key },
      body: JSON.stringify(buildCheckoutBody(input)),
      cache: 'no-store',
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch {
    return { ok: false, status: 0 };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.status === 202 || response.status === 200) {
    const parsed = checkoutResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, status: 502, code: 'invalid_response' };
    return { ok: true, orderId: parsed.data.orderId, replayed: response.headers.get('idempotency-replayed') === 'true', response: parsed.data };
  }

  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const clientError = response.status >= 400 && response.status < 500;
  const retry = Number(response.headers.get('retry-after'));
  return {
    ok: false,
    status: response.status,
    ...(typeof record?.code === 'string' ? { code: record.code } : {}),
    ...(typeof record?.requestId === 'string' ? { requestId: record.requestId } : {}),
    ...(response.headers.get('retry-after') !== null && Number.isFinite(retry) && retry >= 0 ? { retryAfterSeconds: retry } : {}),
    ...(clientError && typeof record?.detail === 'string' ? { detail: record.detail } : {}),
    ...(clientError && record ? { body: record } : {}),
  };
}
