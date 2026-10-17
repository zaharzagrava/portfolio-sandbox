import { openApiDocumentSchema, type OpenApiDocument } from '@marketplace-sandbox/contracts';
import { apiClient } from './client';

/** The description came back, but it is not an OpenAPI 3.x document (AS-28). */
export class OpenApiInvalidError extends Error {
  /** Read by the query client: asking again returns the same wrong body. */
  readonly retryable = false;
  constructor() {
    super('invalid_openapi_document');
    this.name = 'OpenApiInvalidError';
  }
}

/**
 * The public API description for `/developers/docs` (W07 FR-031): the same-origin route `GET /api/developers/openapi.json`,
 * validated before use. A failed request keeps its request error (the page reads `requestId` from it); a body that is
 * not an OpenAPI 3.x description is an `OpenApiInvalidError`.
 */
export async function getOpenApiDocument(): Promise<OpenApiDocument> {
  const response = await apiClient.get('/api/developers/openapi.json', { anonymous: true, headers: { Accept: 'application/json' } });
  const parsed = openApiDocumentSchema.safeParse(response.data);
  if (!parsed.success) throw new OpenApiInvalidError();
  return parsed.data;
}

/** Seller Public API keys (SD-07): `sk_live_…` / `sk_test_…`; the full key is shown once, at creation/rotation. */
export const API_SCOPES = ['products:read', 'products:write', 'orders:read', 'stock:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  scopes: ApiScope[];
  livemode: boolean;
  expiresAt: string | null;
  /** Derived by the server (S42): `revoked` keys are shown as such and offer no actions. */
  status: 'active' | 'rotating' | 'expired' | 'revoked';
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey {
  id: string;
  key: string;
  prefix: string;
  name: string;
  scopes: ApiScope[];
  livemode: boolean;
  createdAt: string;
  /** Rotation only: the old key keeps working until then. */
  previousExpiresAt?: string;
}

export const WEBHOOK_EVENT_TYPES = ['order.paid', 'order.cancelled', 'product.stock_low', 'webhook.ping'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  apiVersion: string;
  enabled: boolean;
  disabledReason: string | null;
  failingSince: string | null;
  createdAt: string;
}

const base = (shopId: string) => `/api/shops/${shopId}/developers`;

export const developersApi = {
  /** S42 answers a page `{items, nextCursor}`; the first page (up to 100 keys) is what the dashboard lists. */
  listKeys: async (shopId: string): Promise<ApiKey[]> => (await apiClient.get<{ items: ApiKey[] }>(`${base(shopId)}/keys`)).data.items,
  createKey: async (shopId: string, data: { name: string; scopes: ApiScope[]; livemode: boolean }): Promise<CreatedApiKey> =>
    (await apiClient.post(`${base(shopId)}/keys`, data)).data,
  rotateKey: async (shopId: string, keyId: string): Promise<CreatedApiKey> => (await apiClient.post(`${base(shopId)}/keys/${keyId}/rotate`)).data,
  revokeKey: async (shopId: string, keyId: string): Promise<void> => {
    await apiClient.delete(`${base(shopId)}/keys/${keyId}`);
  },

  listWebhooks: async (shopId: string): Promise<WebhookEndpoint[]> => (await apiClient.get(`${base(shopId)}/webhooks`)).data,
  /** The signing secret (`whsec_…`) is returned only here and on rotation. */
  createWebhook: async (shopId: string, data: { url: string; events: WebhookEventType[] }): Promise<{ id: string; url: string; events: WebhookEventType[]; secret: string }> =>
    (await apiClient.post(`${base(shopId)}/webhooks`, data)).data,
  deleteWebhook: async (shopId: string, webhookId: string): Promise<void> => {
    await apiClient.delete(`${base(shopId)}/webhooks/${webhookId}`);
  },
  rotateWebhookSecret: async (shopId: string, webhookId: string): Promise<{ secret: string }> =>
    (await apiClient.post(`${base(shopId)}/webhooks/${webhookId}/rotate-secret`)).data,
};
