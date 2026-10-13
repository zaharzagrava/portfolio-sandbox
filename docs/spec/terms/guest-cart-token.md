---
id: guest-cart-token
title: Guest cart token
kind: term
status: draft
aliases: [foreign secret, freshly issued token, signed cookie]
defined_for: S10-cart-checkout
rules_hash: b2a02a15b4b5
---
# Guest cart token
## Definition
The [guest cart](guest-cart.md) token is the signed value in the cookie that ties a signed-out visitor to a guest cart; the first guest write to the cart issues it, and reading the cart never does. [`verifyGuestToken`](verify-guest-token.md) accepts only a token this system issued, unchanged, and treats anything else as "no cart", including a token signed with a foreign secret (a secret this service does not use). Rejecting a token that starts with the marker reserved for signed-in users' carts keeps a guest token from pointing at a user's cart. That reason is design intent (not stated in the spec).

## Example
A guest sends a cookie whose signature was made with another environment's secret (illustrative). [`GET /cart`](get-cart.md) answers as if there were no cookie:
```json
{"lines": [], "droppedLines": 0}
```

## Known gaps
- The spec does not say the cookie's name or lifetime.
- The spec does not say whether the signing secret can be rotated. [The webhook secret](webhook-secret.md), by contrast, accepts the previous secret during rotation.
- The spec does not say the exact token format beyond "contains a dot".

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-03
- [S13](../capabilities/S13-payment-intents.md): R-04
- [get-cart](get-cart.md)
- [guest-cart](guest-cart.md)
- [user-prefix](user-prefix.md)
- [verify-guest-token](verify-guest-token.md)
- [webhook-secret](webhook-secret.md)
<!-- used-by:end -->
