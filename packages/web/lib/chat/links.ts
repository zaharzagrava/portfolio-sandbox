/**
 * Addresses of the product chat (W05 FR-001, FR-003). Other capabilities (the product page, the seller screens) call
 * `chatHref` and never hand-build `/chat?...`. `/chat` takes exactly two query parameters: `channel` (the open chat) and
 * `product` (a one-shot resolver that the page replaces with `channel`).
 */

export function chatHref(target: { product: string } | { channel: string } | Record<string, never>): string {
  if ('product' in target) return `/chat?product=${encodeURIComponent(target.product)}`;
  if ('channel' in target) return `/chat?channel=${encodeURIComponent(target.channel)}`;
  return '/chat';
}

export type ChatTarget =
  | { kind: 'none' }
  | { kind: 'channel'; channelId: string }
  | { kind: 'product'; productId: string }
  /** `channel` is present but not a UUID: the unavailable state, no request (FR-001). */
  | { kind: 'invalid-channel' }
  /** `product` is present but not a UUID: the invalid-link state, no request (FR-001). */
  | { kind: 'invalid-product' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function first(params: Params, name: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined;
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Reads the open chat out of the address. Other parameters are ignored; when both are present the open chat wins. */
export function chatTargetFrom(params: Params): ChatTarget {
  const channel = first(params, 'channel');
  if (channel) return UUID.test(channel) ? { kind: 'channel', channelId: channel } : { kind: 'invalid-channel' };
  const product = first(params, 'product');
  if (product) return UUID.test(product) ? { kind: 'product', productId: product } : { kind: 'invalid-product' };
  return { kind: 'none' };
}
