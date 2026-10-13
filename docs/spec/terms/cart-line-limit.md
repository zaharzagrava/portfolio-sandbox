---
id: cart-line-limit
title: Cart line limit
kind: term
status: draft
aliases: [50 lines]
defined_for: S10-cart-checkout
rules_hash: bd9e8637689b
---
# Cart line limit
## Definition
The cart line limit is the most distinct products one cart may hold. It applies when you set [lines](cart-line.md) and when you [merge](cart-merge.md). During a merge, all of the user's lines are kept. [Guest-only lines](guest-cart.md) fill the remaining space in [`addedAt`](cart-line.md), then `productId` order. The guest lines left out are counted in [`droppedLines`](dropped-lines.md).

## Example
A user cart has 40 lines. The guest cart has 20 other products. After `POST /cart/merge`, the cart holds 50 lines and `droppedLines` is `10`.

## Known gaps
- The spec does not say which status or error code `PUT /cart/items/:productId` returns when it would add a new line to a full cart.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-04
- [cart-line](cart-line.md)
- [cart-merge](cart-merge.md)
- [cart-unit-count](cart-unit-count.md)
- [dropped-lines](dropped-lines.md)
- [guest-cart](guest-cart.md)
<!-- used-by:end -->
