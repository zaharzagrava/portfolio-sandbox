import { SecretBox } from '@app/domains/identity';
import { activeSecrets } from '../domain/signature';
import type { EndpointRecord } from '../domain/webhook-ports';

/** The context a secret is sealed under: a value copied to another endpoint's row does not open (S01). */
export const secretContext = (endpointId: string): string =>
  `webhook-endpoint:${endpointId}`;

/**
 * Opens a sealed secret. Values sealed before S43 v2 carry no context (`v1`); new ones are bound to the endpoint (`v2`).
 */
export function openEndpointSecret(
  box: SecretBox,
  sealed: string,
  endpointId: string,
): string {
  return sealed.startsWith('v2.')
    ? box.open(sealed, secretContext(endpointId))
    : box.open(sealed);
}

/**
 * The secrets that sign an attempt at `nowMs`, chosen at signing time from the injected clock: the current one first,
 * the previous one only while its overlap has not ended (excluded exactly at the expiry instant, FR-013).
 */
export function signingSecrets(
  box: SecretBox,
  endpoint: Pick<
    EndpointRecord,
    'id' | 'secretSealed' | 'previousSecretSealed' | 'previousSecretExpiresAt'
  >,
  nowMs: number,
): string[] {
  return activeSecrets(
    {
      current: openEndpointSecret(box, endpoint.secretSealed, endpoint.id),
      previous: endpoint.previousSecretSealed
        ? openEndpointSecret(box, endpoint.previousSecretSealed, endpoint.id)
        : null,
      previousExpiresAt: endpoint.previousSecretExpiresAt,
    },
    nowMs,
  );
}
