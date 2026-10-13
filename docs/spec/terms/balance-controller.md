---
id: balance-controller
title: BalanceController
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# BalanceController
## Definition
`BalanceController` is the HTTP controller in the [payments API layer](api-layer.md) that serves `GET /shops/:shopId/balance`. It answers only shop members who hold the [`payouts.read`](permission.md) permission. A non-member gets the [identical 404](identical-not-found.md) that an unknown shop gets. The answer carries the shop's [`availableMinor`](available-minor.md), which may be negative, and [`asOf`](as-of.md) shows how fresh the value is. The route has a [per-user rate limit](rate-limit.md), and if the limiter fails, the request still goes through (it fails open).

## Example
A member with `payouts.read` reads their shop's balance:
```http
GET /shops/3f2a9c1e-0000-4000-8000-000000000001/balance
```
```json
{ "availableMinor": 48250, "asOf": "2026-10-13T09:15:02Z" }
```
The shop id, the values and the response shape above are made up for illustration. The same request from a non-member gets `404`, the same as for a shop id that does not exist.

## Known gaps
- The spec does not say the full response body: which fields come back besides `availableMinor` and `asOf`, or whether a currency is included.
- The spec does not say what a member without `payouts.read` gets back, for example `permission_denied (403)` or the same `404`.
- Not confirmed in the code: that `BalanceController` reads through `BalanceQueryService`. That service checks the [hot copy](hot-copy.md) first, then the durable copy, then the running balance.

## Used by
<!-- used-by:start -->
- [api-layer](api-layer.md)
- [hot-copy](hot-copy.md)
- [identical-not-found](identical-not-found.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
