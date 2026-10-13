---
id: sandbox-shop
title: Sandbox shop
kind: term
status: draft
aliases: [sandbox shops]
defined_for: S03-shops-rbac
rules_hash: ecb8174dfe9b
---
# Sandbox shop
## Definition
A sandbox shop is an extra shop that belongs to a seller's real, public shop. [`ensureSandboxShop`](ensure-sandbox-shop.md) creates it, and the operation is [idempotent ↗](../sw-external-terms.md#idempotency): running it again never makes a second sandbox for the same real shop. Public reads hide sandbox shops: the [batch shops lookup](batch-shops-lookup.md) returns `null` for them. Design intent (not stated in the spec): sellers can test there without touching their real storefront.

## Example
`ensureSandboxShop` runs twice for the live shop `acme` (illustrative). Afterwards exactly one sandbox shop exists for it, and `GET /batch/shops?ids=<sandbox id>` returns `[null]`.

## Known gaps
- The spec does not say how a sandbox shop is linked to its live shop, or how code can tell that a shop is a sandbox.
- The spec does not say whether sandbox shops count toward the [10-owned-shops limit](max-owned-shops.md), or whether they have their own members and [seats](seat.md).
- The spec does not say what triggers `ensureSandboxShop`.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-14, B-17
- [batch-shops-lookup](batch-shops-lookup.md)
- [ensure-sandbox-shop](ensure-sandbox-shop.md)
- [get-shops-mine](get-shops-mine.md)
- [live-shop](live-shop.md)
- [max-owned-shops](max-owned-shops.md)
- [seat](seat.md)
- [shop-limit-reached](shop-limit-reached.md)
- [shop-provisioning-service](shop-provisioning-service.md)
<!-- used-by:end -->
