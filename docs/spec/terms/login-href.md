---
id: login-href
title: loginHref
kind: term
status: draft
aliases: []
defined_for: W03-cart-checkout-orders
rules_hash: e3b0c44298fc
---
# loginHref
## Definition
`loginHref` is a helper that builds the sign-in address for a given page. `/checkout` uses it on the server to [redirect an anonymous visitor](anonymous-state.md) before any checkout content is sent. The page passed in, here `/checkout`, is [where the visitor should come back to after signing in](return-path.md).

## Example
An anonymous visitor opens `/checkout`. The server answers with a [redirect ↗](../sw-external-terms.md#http-302-found) to `loginHref('/checkout')`, and the checkout page never renders (rule W03.R-07).

## Known gaps
- The spec does not show the exact URL that `loginHref` produces or the name of its [query parameter ↗](../sw-external-terms.md#query-string).
- Not confirmed in the code: where `loginHref` is defined and whether it validates the return path.

## Used by
<!-- used-by:start -->
- [anonymous-state](anonymous-state.md)
- [return-path](return-path.md)
<!-- used-by:end -->
