---
id: verify-guest-token
title: verifyGuestToken
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# verifyGuestToken
## Definition
`verifyGuestToken` checks the [guest cart token](guest-cart-token.md) that a signed-out caller sends in the [cart cookie](guest-cart-token.md). It accepts only a freshly issued token whose content and [signature ↗](../sw-external-terms.md#digital-signature) are unchanged. It rejects a changed signature, a value with no dot, a [`user:` prefix](user-prefix.md), a [foreign secret](guest-cart-token.md), an empty value and an oversized value. When it rejects a token, the [cart routes](get-cart.md) treat the caller as having no cart. They do not answer with an error.

## Example
A guest sends a cart cookie with no dot in it (the value is illustrative). `GET /cart` answers as if there were no cookie:
```
Cookie: <cart cookie>=abc123nodot
```
```json
{"lines": [], "droppedLines": 0}
```

## Known gaps
- The spec does not say the cookie's name or the exact token format, apart from "contains a dot".
- The spec does not say whether the guest signing secret can be rotated, or what happens to existing guest carts if it is.
- Not confirmed in the code: whether a rejected token is logged or counted anywhere.

## Used by
<!-- used-by:start -->
- [get-cart](get-cart.md)
- [guest-cart-token](guest-cart-token.md)
- [user-prefix](user-prefix.md)
<!-- used-by:end -->
