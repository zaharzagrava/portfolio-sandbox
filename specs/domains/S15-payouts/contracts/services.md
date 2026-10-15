# Service contracts and ports: S15 — `payments` payouts

## Exported from `@app/domains/payments` (public entry point, X.4)

| Export | Kind | Consumers |
|---|---|---|
| `PayoutsModule` | Nest module (HTTP) | `apps/core`, `apps/local-monolith` |
| `PayoutsWorkerModule` | Nest module (jobs) | `apps/worker`, `apps/local-monolith` |

Nothing else of this capability is exported: no model, no repository, no provider port, no service. (`paymentsRatePolicies` is the existing S13/S14 export and gains `finance.payouts.read`.) Removed from the barrel and the modules: `LedgerWorkerModule` no longer provides `PayoutJobs`, `PayoutProvider`, `Payout`. A future seller-facing connect flow would call an exported destination service — not exported now (YAGNI, noted in the spec).

## Consumed R1 (injected only through `domain/` ports whose adapters live in `infra/`)

| Port token (in `domain/payout-ports.ts`) | Adapter | Calls |
|---|---|---|
| `SHOP_SUMMARY_PORT` | `TenancyShopSummaryAdapter` | `ShopQueryService.getShopsByIds(ids ≤ 200)` → `Map<id, {status, payoutsEnabled}>` (only these two fields are used; a missing id = `shop_unknown`); batches of ≤ 200 |
| `PAYOUT_LEDGER` | `LedgerPayoutAdapter` | `LedgerService.postJournal`, `getBalances`, `listSellerBalances`; maps `InsufficientBalance` → `{kind:'insufficient_balance'}`, `LedgerBusy` → `{kind:'ledger_busy'}`, listing failure → `ledger_unavailable`; passes `LEDGER_ACCOUNTS.PAYOUT_CLEARING/PAYOUTS_SENT`, `shopAccount(shopId)` |
| `PAYOUT_PROVIDER` | `StripePayoutProviderAdapter` | `StripeService.createTransfer`, `retrieveTransferByReference` |
| `PAYOUT_JOBS` | `JobsPayoutAdapter` | `JobsService.enqueue('payouts.send', …)` inside the caller's transaction |
| `PAYOUT_EVENTS` | `OutboxPayoutEvents` | `OutboxService.append(event, tx)` |
| repositories | `SequelizePayoutRepository`, `…RunRepository`, `…DestinationRepository`, `…ReserveRepository`, `…AuditRepository` | the owning module's tables only |
| `CLOCK` | S54 clock | every `now` |

## Application services (internal)

```ts
PayoutRunService.run(input: { periodStart?: string; signal: AbortSignal }): Promise<RunSummary>        // period_invalid → RunRefused
PayoutCreationService.createFor(shopId, period, ctx): Promise<'created' | 'existing' | { skipped: SkipReason }>
PayoutTransferService.send(payoutId, ctx: { attempt: number; isLastAttempt: boolean }): Promise<void> // throws TransientPayoutError for the job layer
PayoutTransitionService.apply(payoutId, event: PayoutEvent, effects, tx): Promise<'applied' | 'noop' | { conflict: PayoutStatus }>
PayoutResolverService.resolveDue(limit: number): Promise<{ settled: number; resent: number; unreachable: number }>
PayoutCancelService.cancel(payoutId, actor: string, reason: string): Promise<AdminPayoutView>        // PayoutNotFound | PayoutStateConflict
PayoutDestinationService.set(shopId, providerAccountId, actor): Promise<DestinationView>               // ShopNotFound | DestinationInvalid
PayoutReserveService.set(shopId, reserveBps, reason, actor): Promise<ReserveView>
PayoutQueryService.listForShop / getForShop / upcoming / listAll / listRuns
PayoutAuditService.auditDay(day: string): Promise<AuditSummary>
```

`SkipReason` = `below_minimum | payouts_disabled | shop_not_active | shop_unknown | destination_missing | destination_cooling | insufficient_balance | ledger_busy`. `PayoutEvent` = `claim | provider_success | provider_rejected | provider_unknown | retries_exhausted | resolver_found_paid | resolver_found_rejected | cancel`.

## Pure `domain/` functions (no Nest, no clock, no random source of their own)

```ts
computeReserve(balanceMinor: number, bps: number): { reserveMinor: number; payoutMinor: number }       // BigInt inside
planPayout(balanceMinor, bps, { minMinor, capMinor }): { kind:'pay'; amountMinor; reserveHeldMinor } | { kind:'skip'; reason:'below_minimum' }
periodStartOf(now: Date): string;  validatePeriod(input: unknown, now: Date): { ok: true; periodStart } | { ok: false }
transition(status: PayoutStatus, event: PayoutEvent): PayoutStatus | null                              // null = refused; assertNever over both unions
assessEligibility(facts): { ok: true } | { ok: false; reason: SkipReason }                              // gate order = reason precedence
blockedReason(facts, plan): UpcomingBlockedReason | null
validateDestination(id: string): boolean;  maskDestination(id: string): string;  effectiveFrom(existing, next, now, coolingMs)
resolverDelayMs(unreachableCount: number, random: () => number): number                                // 1,2,4…15 min, full jitter
validateProviderAnswer(expected, answer: unknown): { ok: true; transferRef } | { ok: false; kind: 'amount'|'currency'|'destination'|'missing_transfer' }
nextRunAt(now: Date): Date                                                                              // Monday 06:00 Europe/Warsaw → UTC
```

`random` and `now` are parameters (I.3). `nextRunAt` uses `Intl.DateTimeFormat` with the `Europe/Warsaw` zone through a small helper, tested across both daylight-saving changes.

## Stripe client additions (`libs/infrastructure/stripe/stripe.service.ts`, thin: no payout logic)

```ts
createTransfer(p: { amountMinor; currency; destination; idempotencyKey; transferGroup; timeoutMs }): Promise<Stripe.Transfer>   // maxNetworkRetries: 0, idempotencyKey option
listTransfersByGroup(group: string, timeoutMs: number): Promise<Stripe.Transfer[]>                                              // limit 3
```

The existing `transfer()` is replaced (its only caller was `StripeConnectPayoutProvider`); the load-test branch is kept behind the existing flag. Classification of SDK errors is the **adapter's** job.

## Test seams (not exported from the barrel; `testing/index.ts` for payments e2e specs only)

`FakePayoutProvider` (scriptable: success, rejection code, `429`/`502`/`503`/`504`/reset, timeout, garbage body, wrong amount/currency/destination/reference, lookup found/not found/reversed/unreachable, crash-after-success, block-mid-call; call log; real idempotency-key replay behaviour), `FakeShopSummary` (scriptable `getShopsByIds` with call log), `payout-app.ts` (boots `PayoutsModule` + `PayoutsWorkerModule` with the production pipe/filter/prefix/interceptors), `payout-fixtures.ts` (balances by `postJournal` in a test transaction, shops, members, admins, destinations through the real operator route).
