---
id: max-products
title: maxProducts
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# maxProducts
## Definition
`maxProducts` is the [free-tier](free-tier.md) [entitlement](entitlement.md) that limits how many products a shop may create. When a product would go beyond this limit, product creation answers [`409 plan_limit_reached`](plan-limit.md) with `{key, limit}`. Nothing is written in that case. A [paid plan](plan-limit.md) whose first charge succeeded raises the shop's entitlements above the free tier.

## Example
A free-tier shop already at its limit tries to create one more product:
```json
409 { "code": "plan_limit_reached", "key": "maxProducts", "limit": 5 }
```
(The `key` value and the `limit` of 5 are illustrative.) No product row is created (AS-17).

## Known gaps
- The spec does not give the value of `maxProducts` for the free tier or for any paid plan.
- The spec does not confirm that the `key` member contains the string `maxProducts`.

## Used by
<!-- used-by:start -->
- [entitlement](entitlement.md)
- [free-tier](free-tier.md)
- [plan-limit](plan-limit.md)
<!-- used-by:end -->
