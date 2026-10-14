import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';
import {
  apiKeyCreatedPayloadSchema,
  apiKeyRevokedPayloadSchema,
  apiKeyRotatedPayloadSchema,
  apiRequestLoggedPayloadSchema,
  apiVersionPinnedPayloadSchema,
} from '@marketplace-sandbox/contracts';

/** `api.events`: the key lifecycle and the version pin are outbox events; request records go through the direct producer. */
export const API_AGGREGATE: TopicRegistration = {
  aggregateType: 'api',
  retention: 'full-history',
};

/** One per public API call (key = shopId). ClickHouse request log + usage by version/route (contracts/events.md). */
export const ApiRequestLogged = defineEvent(
  'api.request_logged',
  'api',
  1,
  apiRequestLoggedPayloadSchema,
);

export const ApiKeyCreated = defineEvent(
  'developerplatform.api_key_created',
  'api',
  1,
  apiKeyCreatedPayloadSchema,
);
export const ApiKeyRotated = defineEvent(
  'developerplatform.api_key_rotated',
  'api',
  1,
  apiKeyRotatedPayloadSchema,
);
export const ApiKeyRevoked = defineEvent(
  'developerplatform.api_key_revoked',
  'api',
  1,
  apiKeyRevokedPayloadSchema,
);
export const ApiVersionPinned = defineEvent(
  'developerplatform.api_version_pinned',
  'api',
  1,
  apiVersionPinnedPayloadSchema,
);
