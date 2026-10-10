/** The only reasons a transaction may bypass row-level security (FR-053); anything else throws before a query. */
export const CROSS_TENANT_REASONS = [
  'invite.accept',
  'sso.provision',
  'shop.purge',
  'legacy.provision',
  'membership.mine',
] as const;
export type CrossTenantReason = (typeof CROSS_TENANT_REASONS)[number];

export const isCrossTenantReason = (v: unknown): v is CrossTenantReason =>
  typeof v === 'string' &&
  (CROSS_TENANT_REASONS as readonly string[]).includes(v);
