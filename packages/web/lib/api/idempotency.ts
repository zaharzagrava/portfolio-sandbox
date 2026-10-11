/** A fresh `Idempotency-Key` (UUID v4) for one write attempt; kept for retries of an unchanged form (W02 AS-46, AS-60). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
