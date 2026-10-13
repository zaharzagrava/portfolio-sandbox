---
id: dropped-lines
title: droppedLines
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# droppedLines
## Definition
`droppedLines` is a count returned with the cart. It tells the client how many [guest lines](guest-cart.md) a [cart merge](cart-merge.md) left out because the merged cart hit its [line cap](cart-line-limit.md). A line whose quantity was only capped, and not left out, is not counted. The client can use the count to tell the buyer that some items did not carry over.

## Example
The user cart has 40 lines and the guest cart has 20 other products. After the merge, the cart holds 50 lines and the response includes `"droppedLines": 10`. An empty guest cart from [`GET /cart`](get-cart.md) returns `"droppedLines": 0`.

## Known gaps
- The spec does not say whether a later `GET /cart` still reports the last merge's count or always returns 0.
- The spec does not say which guest lines are dropped beyond the ordering rule. Guest-only lines are kept in [`addedAt`](cart-line.md), then `productId` order, so the lines at the end of that order are the ones dropped.

## Used by
<!-- used-by:start -->
- [cart-line-limit](cart-line-limit.md)
- [cart-merge](cart-merge.md)
- [guest-cart](guest-cart.md)
<!-- used-by:end -->
