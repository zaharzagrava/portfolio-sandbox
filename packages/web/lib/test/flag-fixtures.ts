import {
  flagAuditPageSchema,
  flagPageSchema,
  flagSchema,
  staleFlagsSchema,
  type Flag,
  type FlagAuditPage,
  type FlagPage,
  type StaleFlags,
} from '@marketplace-sandbox/contracts';

/**
 * W06 test fixtures. Every success body is parsed with its contracts schema when it is built, so a fixture that drifts from the
 * wire shape fails loudly (test-plan "UI unit", gaps F9).
 */
export const FLAGS_URL = 'http://localhost:3000/api/admin/flags';

export const flagFixture = (over: Partial<Flag> = {}): Flag =>
  flagSchema.parse({
    key: 'new-checkout',
    description: 'Checkout v2',
    owner: 'admin@marketplace.local',
    status: 'disabled',
    enabled: false,
    variants: [
      { key: 'off', value: false },
      { key: 'on', value: true },
    ],
    defaultVariant: 'off',
    offVariant: 'off',
    rules: [],
    bucketBy: 'userId',
    clientSide: false,
    expiresAt: null,
    version: 3,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...over,
  });

export const flagPageFixture = (items: Flag[] = [flagFixture()], nextCursor: string | null = null): FlagPage => flagPageSchema.parse({ items, nextCursor });

export const auditFixture = (over: Record<string, unknown> = {}) => ({
  id: '41',
  flagKey: 'new-checkout',
  action: 'update',
  actorId: 'u-admin',
  requestId: 'req-41',
  at: '2026-10-02T10:00:00.000Z',
  before: null,
  after: flagFixture() as unknown as Record<string, unknown>,
  ...over,
});

export const auditPageFixture = (items: ReturnType<typeof auditFixture>[] = [auditFixture()], nextCursor: string | null = null): FlagAuditPage =>
  flagAuditPageSchema.parse({ items, nextCursor });

export const staleFixture = (items: StaleFlags['items'] = [], days = 14): StaleFlags => staleFlagsSchema.parse({ days, items });

/** A problem+json body as the backend sends it (`code`, `requestId`, extension members; never trusted for copy). */
export const problemBody = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: 'about:blank',
  title: 'Server title',
  status,
  detail: 'Server detail that must never reach the page',
  code,
  requestId: 'req-test',
  ...extra,
});
