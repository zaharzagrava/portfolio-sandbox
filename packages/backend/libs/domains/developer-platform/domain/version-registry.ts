import type { DeprecationEntry } from './deprecation';

/**
 * The one registry of API versions (FR-024): ordered ascending by date, each with its lifecycle and — from the second
 * entry on — the change it introduced, as request upgraders (older shape → latest) and response downgraders
 * (latest → this entry's predecessor). Adding a version = one entry here, no handler changes.
 */
export type VersionResource = 'product' | 'order';
type Json = Record<string, unknown>;

export type VersionLifecycle =
  | { status: 'supported' }
  | { status: 'deprecated'; deprecatedAt: string; sunset: string }
  | { status: 'retired' };

export interface UpgradeContext {
  /** Currency of the platform (or of the product being written) for shapes that carried none. */
  currency: string;
}

export interface VersionChange {
  description: string;
  /** From THIS version's shape to the previous version's shape. */
  downgrade: Record<VersionResource, (resource: Json) => Json>;
  /** Converts a product write body of the PREVIOUS version to this version's shape. */
  upgradeProductWrite: (body: Json, ctx: UpgradeContext) => Json;
}

export interface VersionEntry {
  version: string;
  lifecycle: VersionLifecycle;
  change?: VersionChange;
}

const amountOf = (m: unknown): number | undefined =>
  (m as { amount?: number } | undefined)?.amount;

const v20261001: VersionChange = {
  description:
    'Product `price` became a money object {amount, currency}; `quantity` renamed to `stock`; `brand` required. Order `total` and line `unit_price` became money objects.',
  downgrade: {
    product: ({ price, stock, ...rest }) => ({
      ...rest,
      price: amountOf(price),
      quantity: stock,
    }),
    order: ({ total, lines, ...rest }) => ({
      ...rest,
      total: amountOf(total),
      currency: (total as { currency?: string } | undefined)?.currency,
      ...(Array.isArray(lines) && {
        lines: lines.map(({ unit_price, ...line }: Json) => ({
          ...line,
          unit_price: amountOf(unit_price),
        })),
      }),
    }),
  },
  upgradeProductWrite: ({ price, quantity, brand, ...rest }, ctx) => ({
    ...rest,
    ...(typeof price === 'number' && {
      price: { amount: price, currency: ctx.currency },
    }),
    ...(price !== undefined && typeof price !== 'number' && { price }),
    ...(quantity !== undefined && { stock: quantity }),
    brand: typeof brand === 'string' && brand.length > 0 ? brand : 'Unbranded',
  }),
};

export const VERSION_REGISTRY: readonly VersionEntry[] = [
  {
    version: '2026-01-15',
    lifecycle: {
      status: 'deprecated',
      deprecatedAt: '2026-10-01T00:00:00Z',
      sunset: '2027-04-01T00:00:00Z',
    },
  },
  {
    version: '2026-10-01',
    lifecycle: { status: 'supported' },
    change: v20261001,
  },
];

/** Read at call time: registering a version (one entry above) changes them with no other edit (AS-26, AS-31). */
export const apiVersions = (): readonly string[] =>
  VERSION_REGISTRY.map((v) => v.version);
export const latestVersion = (): string =>
  VERSION_REGISTRY[VERSION_REGISTRY.length - 1].version;
export const versionEntry = (version: string): VersionEntry | undefined =>
  VERSION_REGISTRY.find((v) => v.version === version);

/** Load-time snapshots kept for S43's webhook code, which declares them in decorators; this capability uses the functions. */
export const API_VERSIONS: readonly string[] = apiVersions();
export const LATEST_VERSION: string = latestVersion();

/** Routes on their way out (RFC 9745 Deprecation, RFC 8594 Sunset) — validated at startup (FR-031). */
export const DEPRECATED_ROUTES: Record<string, DeprecationEntry> = {
  'GET /v1/products/:id/stock': {
    deprecatedAt: '2026-10-01T00:00:00Z',
    sunset: '2027-04-01T00:00:00Z',
    replacement: '/v1/stock/{productId}',
  },
};
