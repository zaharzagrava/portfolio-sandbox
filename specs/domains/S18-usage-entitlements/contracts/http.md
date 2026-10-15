# HTTP contracts: S18

All errors are RFC 9457 problem+json with a stable `code`; 5xx details are generic. Both routes are `GET`, so no `Idempotency-Key`.

## `GET /shops/:shopId/usage?month=YYYY-MM`

- Auth: `Firewall`, then `ShopScoped('shop.read')` (S03). Non-member or unknown shop: `404` with one identical body. No credentials: `401`.
- `month` optional (default: current UTC month); format `^\d{4}-(0[1-9]|1[0-2])$`; between 12 months ago and the current month, else `400 validation_failed`.
- Rate limit policy `billing.usage-read.subject`: 60/min per subject, fail closed → `429` with `Retry-After`.
- `200` body `usageSummarySchema` (`packages/contracts/src/billing/usage.ts`):

```json
{ "month": "2026-04", "periodStart": "2026-04-01T00:00:00.000Z", "periodEnd": "2026-05-01T00:00:00.000Z",
  "asOf": "<ISO>", "metrics": [ { "metric": "api.calls", "used": 12500, "limit": 1000000, "remaining": 987500 } ] }
```

  `metrics` sorted by name; every quota-mapped metric present (0 usage allowed); other metrics with usage carry `limit: null, remaining: null`; `remaining = max(0, limit − used)`.
- `503 usage_unavailable` when the usage store fails (no store message, SQL or stack in body or logs).

## `GET /me/usage?month=YYYY-MM`

Same body for the session user only; takes no subject parameter. Same limits and errors (no `404`).

## Guard

`RequiresShopEntitlement(feature)` above `ShopScoped(...)`: lacks feature → `403 entitlement_required` with `feature` extension (existing class `Domain_EntitlementRequiredError`); answer unknown and nothing usable cached → `503 entitlements_unavailable`; handler not run in either case. A guarded handler without `ShopScoped` or with a key outside the allowlist fails application startup naming the route.
