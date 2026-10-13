---
id: user-prefix
title: user: prefix
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# user: prefix
## Definition
The `user:` prefix is a [token shape](guest-cart-token.md) that [`verifyGuestToken`](verify-guest-token.md) always rejects. A [guest cart cookie](guest-cart-token.md) whose value starts with `user:` counts as "no cart", even if the rest looks valid. Design intent (not stated in the spec): this stops a guest token from pointing at a [signed-in user's cart](cart.md), because a signed-in caller must always use the user's cart.

## Example
A client puts a hand-made value in the cart cookie (the value is illustrative). [`GET /cart`](get-cart.md) returns an empty cart, and no user's cart is read:
```
Cookie: <cart cookie>=user:42.somesignature
```
```json
{"lines": [], "droppedLines": 0}
```

## Known gaps
- The spec does not say where the `user:` form is used inside the system, for example as an internal cart key.
- The spec does not say whether other prefixes are also reserved.

## Used by
<!-- used-by:start -->
- [cart](cart.md)
- [guest-cart-token](guest-cart-token.md)
- [verify-guest-token](verify-guest-token.md)
<!-- used-by:end -->
