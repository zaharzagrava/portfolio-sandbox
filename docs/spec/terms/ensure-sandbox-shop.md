---
id: ensure-sandbox-shop
title: ensureSandboxShop
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# ensureSandboxShop
## Definition
`ensureSandboxShop` makes sure a [live shop](live-shop.md) has one [sandbox shop](sandbox-shop.md) next to it. It is [idempotent ↗](../sw-external-terms.md#idempotency): calling it again for the same live shop does not create a second sandbox. Sandbox shops are hidden from the anonymous [`GET /batch/shops`](batch-shops-lookup.md) read, which returns `null` for them.

## Example
Shop `acme-tools` (illustrative) is live. The first `ensureSandboxShop` call creates its sandbox shop. A second call leaves exactly one sandbox shop.

## Known gaps
- The spec does not say how a sandbox shop is linked to its live shop, or which plan, status and members it gets.
- The spec does not say whether the sandbox shop uses up the owner's [owned-shop allowance](max-owned-shops.md) (S03.R-12) or any seats.
- Not confirmed in the code: which service holds this operation, or what calls it.

## Used by
<!-- used-by:start -->
- [live-shop](live-shop.md)
- [max-owned-shops](max-owned-shops.md)
- [sandbox-shop](sandbox-shop.md)
<!-- used-by:end -->
