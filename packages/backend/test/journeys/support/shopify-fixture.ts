import {
  integrationSchema,
  type Integration,
} from '@marketplace-sandbox/contracts';
import { API_URL } from './journey-client';
import type { FixtureShop } from './catalog-fixture';
import type { ShopifyDouble } from './shopify-double';
import { waitForContract } from './wait-for-contract';

/**
 * Plays the seller and the browser of the Shopify install (spec.md AS-05): `POST …/integrations/shopify/install` with the
 * double's `host:port` as the shop domain, then the callback the double signs (`302 ?connected=<integrationId>`). Returns the
 * integration id. A second delivery of the same callback is the caller's business (`callbackAgain`).
 */
export async function connectShopify(
  shop: FixtureShop,
  double: ShopifyDouble,
): Promise<{ integrationId: string; query: string }> {
  const install = await shop.owner.post<{ authorizeUrl: string }>(
    `/api/shops/${shop.shopId}/integrations/shopify/install`,
    { body: { shopDomain: double.host } },
  );
  if (install.status !== 200)
    throw new Error(
      `install: ${install.status} ${JSON.stringify(install.body)}`,
    );
  const state = new URL(install.body.authorizeUrl).searchParams.get('state');
  if (!state) throw new Error('install: the authorize URL carries no state');
  const query = double.signedCallback(state);
  const response = await callback(query);
  if (response.status !== 302)
    throw new Error(`callback: ${response.status} ${await response.text()}`);
  const connected = new URL(
    response.headers.get('location') ?? '',
    API_URL,
  ).searchParams.get('connected');
  if (!connected)
    throw new Error(
      `callback: the redirect carries no ?connected= (${response.headers.get('location')})`,
    );
  return { integrationId: connected, query };
}

/** `GET /api/integrations/shopify/callback?…`, never following the redirect. */
export const callback = (query: string): Promise<Response> =>
  fetch(`${API_URL}/api/integrations/shopify/callback?${query}`, {
    redirect: 'manual',
  });

export async function readIntegration(
  shop: FixtureShop,
  integrationId: string,
): Promise<Integration> {
  const reply = await shop.owner.get(
    `/api/shops/${shop.shopId}/integrations/${integrationId}`,
    { schema: integrationSchema },
  );
  if (reply.status !== 200)
    throw new Error(
      `integration ${integrationId}: ${reply.status} ${JSON.stringify(reply.body)}`,
    );
  return integrationSchema.parse(reply.body);
}

/** J04.H4: the backfill has linked `count` products and the integration is ACTIVE. */
export const waitLinked = (
  shop: FixtureShop,
  integrationId: string,
  count: number,
): Promise<Integration> =>
  waitForContract('J04.H4', async () => {
    const view = await readIntegration(shop, integrationId);
    return view.status === 'ACTIVE' && view.linkedProducts === count
      ? view
      : null;
  });

/** The route a provider webhook for an integration is posted to. */
export const webhookUrl = (integrationId: string): string =>
  `${API_URL}/api/integrations/${integrationId}/webhooks`;

/** Disconnects the integration (best effort, used in `afterAll` so the next story can connect the same store). */
export async function disconnect(
  shop: FixtureShop,
  integrationId: string,
): Promise<void> {
  await shop.owner
    .call('DELETE', `/api/shops/${shop.shopId}/integrations/${integrationId}`)
    .catch(() => undefined);
}
