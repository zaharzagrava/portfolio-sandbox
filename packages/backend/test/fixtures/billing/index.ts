export { createDelivery } from '../statements/harness';

/**
 * Dataset DS-1 of S17 (spec.md): the catalog the migration seeds — plan `plus` (BUYER) monthly 499 and yearly 4990,
 * `starter` (SHOP) monthly 1900 per seat including 10,000 `api.calls`, overage 50 per 1,000, `pro` (SHOP) monthly 9900
 * per seat including 1,000,000, overage 20 — put back before every spec, because the catalog tables survive
 * `seeds.clean()` and specs retire and publish prices. Test code only (IX.6).
 */
export const DS1_SEED_SQL = [
  `DELETE FROM "Price"`,
  `DELETE FROM "Plan"`,
  `INSERT INTO "Plan" (code, name, audience, entitlements) VALUES
     ('plus', 'Marketplace Plus', 'BUYER', '{"freeShipping": true, "earlyAccessDrops": true}'),
     ('starter', 'Starter', 'SHOP', '{"maxProducts": 100, "seats": 5, "auctions": false, "apiCallsPerMonth": 10000, "assistantTokensPerMonth": 0}'),
     ('pro', 'Pro', 'SHOP', '{"maxProducts": 10000, "seats": 25, "auctions": true, "apiCallsPerMonth": 1000000, "assistantTokensPerMonth": 2000000}')`,
  `INSERT INTO "Price" ("planId", "interval", "unitAmount", "perSeat", "includedUsage", "overagePer1000", "version")
   SELECT id, 'MONTH', 499, FALSE, '{}'::jsonb, '{}'::jsonb, 1 FROM "Plan" WHERE code = 'plus'
   UNION ALL SELECT id, 'YEAR', 4990, FALSE, '{}'::jsonb, '{}'::jsonb, 1 FROM "Plan" WHERE code = 'plus'
   UNION ALL SELECT id, 'MONTH', 1900, TRUE, '{"api.calls": 10000}'::jsonb, '{"api.calls": 50}'::jsonb, 1 FROM "Plan" WHERE code = 'starter'
   UNION ALL SELECT id, 'MONTH', 9900, TRUE, '{"api.calls": 1000000}'::jsonb, '{"api.calls": 20}'::jsonb, 1 FROM "Plan" WHERE code = 'pro'`,
];

/** Plan codes of DS-1. */
export type Ds1Plan = 'plus' | 'starter' | 'pro';

/** The fixed instant most spec examples use. */
export const DEFAULT_NOW = '2026-04-10T12:00:00.000Z';
