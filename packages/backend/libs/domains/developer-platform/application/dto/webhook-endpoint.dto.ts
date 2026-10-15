import type {
  CreatedWebhookEndpoint,
  RotateWebhookSecretRequest,
  WebhookEndpointDto,
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
} from '@marketplace-sandbox/contracts';
import type { EndpointRecord } from '../../domain/webhook-ports';

/**
 * Request and response shapes of the endpoint routes. The schemas (whitelist, unknown properties refused) live in
 * `packages/contracts` and are applied by the controller's pipe; this file holds the types and the one mapping from a
 * stored endpoint to its public form, which never carries a secret (FR-015).
 */
export type {
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
  RotateWebhookSecretRequest,
  WebhookEndpointDto,
  CreatedWebhookEndpoint,
};

export interface WebhookEndpointPage {
  items: WebhookEndpointDto[];
  nextCursor: string | null;
}

export interface RotatedSecret {
  secret: string;
  previousSecretExpiresAt: string;
}

/** `breaker` is `open` while the circuit is open or probing, `closed` otherwise. */
export function toEndpointDto(
  endpoint: EndpointRecord,
  state: { breaker: 'closed' | 'open'; now: Date },
): WebhookEndpointDto {
  const previousValid =
    endpoint.previousSecretSealed !== null &&
    endpoint.previousSecretExpiresAt !== null &&
    endpoint.previousSecretExpiresAt.getTime() > state.now.getTime();
  return {
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    apiVersion: endpoint.apiVersion,
    status: endpoint.status,
    disabledReason: endpoint.disabledReason,
    failingSince: endpoint.failingSince?.toISOString() ?? null,
    breaker: state.breaker,
    hasPreviousSecret: previousValid,
    previousSecretExpiresAt: previousValid
      ? endpoint.previousSecretExpiresAt!.toISOString()
      : null,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}
