---
id: get-cart
title: GET /cart
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: 4f62c80a628e
---
# GET /cart
## Definition
`GET /cart` returns the caller's cart. A signed-in caller gets the user's cart. Otherwise the caller gets the [guest cart](guest-cart.md) named by the [signed cookie](guest-cart-token.md). It never sets a cookie, so reading never creates a guest cart. Cart reads are not [rate limited](rate-limit.md), and [expired cart lines](cart-line.md) are not returned.

## Example
A guest with no cookie calls `GET /cart`:
```
200 {"lines": [], "droppedLines": 0}
```
No `Set-Cookie` header comes back. The first `PUT /cart/items/:productId` issues the cookie.

## Known gaps
- The spec does not say what [`droppedLines`](dropped-lines.md) means on a plain read outside a merge. For example, it does not say whether the value from the last merge is kept.
- The spec does not list the members of each line in the response.

## Used by
<!-- used-by:start -->
- [cart-line](cart-line.md)
- [guest-cart-token](guest-cart-token.md)
- [guest-cart](guest-cart.md)
- [rate-limit](rate-limit.md)
- [verify-guest-token](verify-guest-token.md)
<!-- used-by:end -->
