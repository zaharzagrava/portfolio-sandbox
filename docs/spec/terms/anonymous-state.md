---
id: anonymous-state
title: Anonymous state
kind: term
status: draft
aliases: [anonymous]
defined_for: W01-auth-account
rules_hash: 2ecd17fdc690
---
# Anonymous state
## Definition
The anonymous state is one of the four states of the navbar [account slot](account-slot.md). The other three are loading, signed in and [unavailable](account-unavailable.md). In this state the navbar shows **Log in** and **Sign up** instead of the account menu. The slot enters it when the [session check](get-api-bff-session.md) answers that nobody is signed in, after a successful sign-out, or when the local session ends. A failed session check caused by an outage or no network shows the unavailable state instead. This keeps an outage from looking like a sign-out.

## Example
A member has two tabs open and chooses **Log out** in one. [`POST /api/bff/session/logout`](post-bff-session-logout.md) succeeds, and that tab goes to `/login?notice=signed_out`. The [`auth` BroadcastChannel ↗](../sw-external-terms.md#broadcast-channel) then tells the other tab, which shows the anonymous navbar within 1 second.

## Known gaps
- The spec does not say whether a failed [`POST /api/bff/session/refresh`](post-bff-session-refresh.md) moves the slot to the anonymous state.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-06
- [S51](../capabilities/S51-realtime-push.md): B-07, B-08
- [W03](../capabilities/W03-cart-checkout-orders.md): R-07
- [account-slot](account-slot.md)
- [account-unavailable](account-unavailable.md)
- [checkout-review-step](checkout-review-step.md)
- [get-api-bff-session](get-api-bff-session.md)
- [login-href](login-href.md)
- [navbar-unavailable-state](navbar-unavailable-state.md)
- [query-keys-auth-session](query-keys-auth-session.md)
- [toast](toast.md)
<!-- used-by:end -->
