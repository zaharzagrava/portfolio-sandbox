---
id: payouts-enabled
title: payoutsEnabled
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# payoutsEnabled
## Definition
`payoutsEnabled` is a boolean field on a shop. It tells whether the shop may receive payouts. It is true only when [shop verification](shop-verification.md) is [`VERIFIED`](shop-verification.md), and false in every other verification state. A new shop always starts with it false.

## Example
[`POST /shops`](post-shops.md) returns `"verification": "UNVERIFIED", "payoutsEnabled": false`. After the shop moves `PENDING → VERIFIED`, it reads `"payoutsEnabled": true`.

## Known gaps
- Not confirmed in the code: whether the value is stored or computed from the verification status on each read.
- The spec does not say which capability reads this flag before it pays a seller.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-06
- [shop-verification](shop-verification.md)
<!-- used-by:end -->
