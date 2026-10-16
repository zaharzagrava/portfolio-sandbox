---
id: get-shop-balance
title: GET /shops/:shopId/balance
kind: term
status: draft
aliases: [/shops/:shopid/balance]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# GET /shops/:shopId/balance
## Definition
`GET /shops/:shopId/balance` is the HTTP route a shop uses to read its available balance. [`BalanceController`](balance-controller.md) serves it. Only a shop member with the [`payouts.read`](permission.md) permission gets an answer. A non-member gets [the same `404` as for an unknown shop](identical-not-found.md), so the route never shows whether a shop exists. The value is read from the [read model](read-model.md): first the [hot copy](hot-copy.md), then the [durable copy](durable-copy.md), then the [running balance](running-balance.md). [`asOf`](as-of.md) shows how fresh the value is.

The answer's [`availableMinor`](available-minor.md) can be negative. The route has a [per-user rate limit](rate-limit.md), and when the limiter itself fails the request still goes through (it [fails open ↗](../sw-external-terms.md#fail-open-fail-closed)).

## Example
A shop owner with `payouts.read` asks for the balance of their shop:
```http
GET /shops/3f2a9c1e-0000-4000-8000-000000000001/balance
```
```json
{ "availableMinor": 48250, "asOf": "2026-10-13T09:15:02Z" }
```
(the shop id, the values and the response shape are illustrative)

The same request from a user who is not a member of that shop gets `404`, exactly like a request for a shop id that does not exist.

## Known gaps
- The spec does not say the full response body: which members come back besides `availableMinor`, where `asOf` goes, or whether a currency is included.
- The spec does not say what a member without `payouts.read` gets back, for example [`permission_denied (403)`](permission-denied.md) or the same `404`.
- The spec does not say how a shop with balances in more than one currency is shown.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): B-06
- [durable-copy](durable-copy.md)
- [hot-copy](hot-copy.md)
- [identical-not-found](identical-not-found.md)
- [rate-limit](rate-limit.md)
- [read-model](read-model.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
