---
id: navbar
title: Navbar
kind: term
status: draft
aliases: [navbar account slot]
defined_for: W01-auth-account
rules_hash: 8cc2a2761e88
---
# Navbar
## Definition
The navbar is the bar at the top of every web page. Its account part is a place in the bar that shows the visitor's account state, plus matching links in the mobile menu. That state comes from the server's check of the current sign-in, read through [`queryKeys.auth.session()`](query-keys-auth-session.md). Because the session is held once as server data, every part of the page shows the same state. The navbar also changes without a reload after sign-in, after sign-out in another tab, or after a session refresh.

## Example
A member has two tabs open and chooses **Log out** in one of them. [`POST /api/bff/session/logout`](post-bff-session-logout.md) succeeds, and a message goes out on the [`auth` BroadcastChannel ↗](../sw-external-terms.md#broadcast-channel). Within 1 second, the other tab's navbar shows **Log in** and **Sign up**.

## Known gaps
- The spec does not say what the navbar shows in the ["unavailable" state](navbar-unavailable-state.md). It only says this state must not look like the anonymous state.
- The spec does not describe anything in the navbar other than the account slot and the mobile menu entries.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-03, B-03, B-04
- [account-slot](account-slot.md)
- [cart-badge-display-ceiling](cart-badge-display-ceiling.md)
- [client-island](client-island.md)
- [get-api-bff-session](get-api-bff-session.md)
- [is-admin](is-admin.md)
- [navbar-menu-entry](navbar-menu-entry.md)
- [navbar-unavailable-state](navbar-unavailable-state.md)
- [presentation-only](presentation-only.md)
<!-- used-by:end -->
