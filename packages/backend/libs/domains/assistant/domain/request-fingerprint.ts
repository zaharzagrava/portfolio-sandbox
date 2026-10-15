import { createHash } from 'node:crypto';

export interface SendRequestBody {
  conversationId: string;
  text: string;
  lat?: number;
  lng?: number;
}

/** Fixed 6 decimals, so `52.5` and `52.500000` agree; `-0` and `0` agree too. */
function coordinate(value: number | undefined): string | null {
  if (value === undefined) return null;
  const fixed = value.toFixed(6);
  return fixed === '-0.000000' ? '0.000000' : fixed;
}

/**
 * SHA-256 over canonical JSON `{conversationId, text (trimmed), lat, lng}` in fixed field order (research R-6). The same
 * key with another fingerprint is `422 idempotency_key_reuse` (AS-65).
 */
export function requestFingerprint(body: SendRequestBody): string {
  const canonical = JSON.stringify({
    conversationId: body.conversationId,
    text: body.text.trim(),
    lat: coordinate(body.lat),
    lng: coordinate(body.lng),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
