# In-process contracts: S18

## Exported from `@app/domains/billing` (R1)

```ts
EntitlementsService {
  get(subjectType: 'USER'|'SHOP', subjectId: string): Promise<Entitlements>
  getMany(subjectType, subjectIds: string[]): Promise<Map<string, Entitlements>>   // ≤ 500 distinct, one batch call
  hasEntitlement(subjectType, subjectId, feature: EntitlementKey): Promise<boolean>
  checkLimit(subjectType, subjectId, key: 'maxProducts'|'seats', current: number): Promise<{allowed, limit, remaining}>
  checkQuota(subjectType, subjectId, key: 'apiCallsPerMonth'|'assistantTokensPerMonth'): Promise<{allowed, used, limit, resetsAt}>
  invalidate(subjectType, subjectId): Promise<void>   // rejects when the entry cannot be dropped
}
RequiresShopEntitlement(feature: EntitlementKey)
types Entitlements, EntitlementKey, QuotaKey, QuotaStatus
```

Removed from the barrel: `UsageService`, `UsageRecorded`, `UsageProjector`, models. Kept: `BillingModule`, `BillingWorkerModule`, `BillingConsumerModule`, `billingRatePolicies`, S17's exports.

## Same domain (S17 renewal)

```ts
UsageInvoiceLinesProvider.linesFor({subscriptionId, subjectId, priceId, periodStart, periodEnd, measuredAt, timeoutMs}):
  Promise<{lines: UsageLine[], settlement: SettlementPlan}>   // read-only; ≤ 5 s; invalid_input | usage_unavailable
UsageSettlementService.settle({invoiceId, subscriptionId, settlement}): Promise<void>   // inside the invoice transaction; idempotent by invoiceId; settlement_conflict
```

## Domain ports (`domain/ports.ts`, injection tokens; adapters in `infra/`)

- `UsageStorePort`: `insert(records)` (rejects on failure), `totals(subjectId, metric, from, to)` (exact, 5 s timeout), `totalsMany(subjectId, [{metric, from, to}])`.
- `SettlementRepository`: `findOpen(subscriptionId)`, `insertFirst(entry, invoiceId)`, `advance(entry, invoiceId)` (conditional on `fromQuantity`), `close`, `scanOpen(cursor, limit)`.
- `EntitlementCachePort`: `load(subjectType, id, loader)`, `loadMany`, `invalidate`, `invalidateIfOlder(version)`.
