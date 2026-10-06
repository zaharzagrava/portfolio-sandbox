/**
 * Date-based API versions (Stripe-style, 04/02 §2). The handlers always
 * produce the LATEST shape; for an older version, the response walks back
 * through each change newer than the requested version and undoes it. Adding
 * a breaking change = one entry here, nothing else forks.
 */
export const API_VERSIONS = ['2026-01-15', '2026-10-01'] as const;
export type ApiVersion = (typeof API_VERSIONS)[number];
export const LATEST_VERSION: ApiVersion = '2026-10-01';

export type ApiResourceType = 'product' | 'order' | 'list';

interface VersionChange {
  version: ApiVersion;
  description: string;
  /** Converts a resource FROM this version's shape TO the previous version's shape. */
  downgrade: Partial<Record<Exclude<ApiResourceType, 'list'>, (resource: Record<string, unknown>) => Record<string, unknown>>>;
}

export const VERSION_CHANGES: VersionChange[] = [
  {
    version: '2026-10-01',
    description: 'Product `price` became a money object {amount, currency}; `quantity` renamed to `stock`. Order `total` became a money object.',
    downgrade: {
      product: ({ price, stock, ...rest }) => ({ ...rest, price: (price as { amount: number } | undefined)?.amount, quantity: stock }),
      order: ({ total, ...rest }) => ({ ...rest, total: (total as { amount: number } | undefined)?.amount, currency: (total as { currency: string } | undefined)?.currency }),
    },
  },
];

export function isApiVersion(value: string | undefined): value is ApiVersion {
  return !!value && (API_VERSIONS as readonly string[]).includes(value);
}

/** Applies every downgrade for changes newer than `target`, newest first. Lists transform each item in `data`. */
export function transformForVersion(type: ApiResourceType, body: unknown, target: ApiVersion, itemType?: Exclude<ApiResourceType, 'list'>): unknown {
  if (target === LATEST_VERSION || body === null || typeof body !== 'object') return body;
  if (type === 'list') {
    const list = body as { data: Record<string, unknown>[] };
    return { ...list, data: list.data.map((item) => transformForVersion(itemType!, item, target)) };
  }
  let resource = body as Record<string, unknown>;
  for (const change of [...VERSION_CHANGES].sort((a, b) => b.version.localeCompare(a.version))) {
    if (change.version <= target) break;
    resource = change.downgrade[type]?.(resource) ?? resource;
  }
  return resource;
}

/** Endpoints on their way out: announced via headers (RFC 8594 Sunset, RFC 9745 Deprecation) on every call. */
export const DEPRECATED_ROUTES: Record<string, { deprecatedAt: string; sunset: string; replacement: string }> = {
  'GET /v1/products/:id/stock': { deprecatedAt: '2026-10-01', sunset: '2027-04-01', replacement: '/v1/stock/{productId}' },
};
