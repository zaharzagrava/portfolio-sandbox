/**
 * W06 visual-suite fixtures (gaps F9): flag bodies in the wire shape of `flagSchema` / `flagAuditPageSchema` /
 * `staleFlagsSchema`. The Vitest suite parses the same shapes with the contracts schemas (`lib/test/flag-fixtures.ts`); the
 * browser stubs only need plain objects.
 */
export const flagBody = (over: Record<string, unknown> = {}) => ({
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

export const LONG_KEY = `${'long-flag-key-'.repeat(4)}end`.slice(0, 64);
export const LONG_TEXT = 'A very long description that has to wrap inside its cell and never widen the page. '.repeat(6).slice(0, 500);

export const listPage = (nextCursor: string | null = null) => ({
  items: [
    flagBody({ key: 'alpha-flag', status: 'enabled', enabled: true, description: 'Short', clientSide: true, expiresAt: '2026-12-01T00:00:00.000Z' }),
    flagBody({ key: 'beta-flag', status: 'disabled', description: '' }),
    flagBody({ key: 'gamma-flag', status: 'killed' }),
    flagBody({ key: 'delta-flag', status: 'archived' }),
    flagBody({ key: LONG_KEY, description: LONG_TEXT, owner: 'someone.with.a.very.long.address@example-company-name.com' }),
  ],
  nextCursor,
});

/** 20 variants and 50 rules: the editor's largest legal definition. */
export const bigFlag = (key: string, over: Record<string, unknown> = {}) =>
  flagBody({
    key,
    variants: Array.from({ length: 20 }, (_, i) => ({ key: `variant-${i + 1}`, value: i % 2 === 0 ? `value ${i + 1}` : i }) ),
    defaultVariant: 'variant-1',
    offVariant: 'variant-1',
    rules: Array.from({ length: 50 }, (_, i) => ({
      id: `rule-${i + 1}`,
      conditions: [{ attribute: 'email_domain', op: 'in', values: [`team${i + 1}.example.com`] }],
      variant: 'variant-2',
    })),
    ...over,
  });

export const auditPage = (key: string, nextCursor: string | null = null) => ({
  items: [
    { id: '30', flagKey: key, action: 'kill', actorId: 'actor-someone-else-0000-1111', requestId: 'req-30-aaaa-bbbb', at: '2026-10-03T12:00:00.000Z', before: flagBody({ key, status: 'enabled', enabled: true }), after: flagBody({ key, status: 'killed' }) },
    { id: '20', flagKey: key, action: 'update', actorId: 'actor-someone-else-0000-1111', requestId: 'req-20-aaaa-bbbb', at: '2026-10-02T12:00:00.000Z', before: flagBody({ key, description: LONG_TEXT }), after: flagBody({ key, status: 'enabled', enabled: true, description: 'Short' }) },
    { id: '10', flagKey: key, action: 'create', actorId: 'actor-someone-else-0000-1111', requestId: null, at: '2026-10-01T12:00:00.000Z', before: null, after: flagBody({ key }) },
  ],
  nextCursor,
});

export const staleBody = (days = 14) => ({
  days,
  items: [
    { key: 'old-flag', owner: 'admin@marketplace.local', status: 'enabled', expiresAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', evaluations: 120, expired: true, reason: 'expired' },
    { key: LONG_KEY, owner: 'someone.with.a.very.long.address@example-company-name.com', status: 'disabled', expiresAt: null, createdAt: '2026-02-01T00:00:00.000Z', evaluations: 0, expired: false, reason: 'unused' },
  ],
});
