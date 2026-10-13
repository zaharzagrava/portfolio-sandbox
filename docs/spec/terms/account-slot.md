---
id: account-slot
title: Account slot
kind: term
status: draft
aliases: [accountslot, slot]
defined_for: W01-auth-account
rules_hash: 18e13d27dac0
---
# Account slot
## Definition
The account slot is the part of the [navbar](navbar.md) (and the mobile menu) that shows the visitor's account state. It is rendered by `AccountSlot`, with the client part in `AccountSlotClient`. The slot has four states: loading, anonymous, signed in and [unavailable](account-unavailable.md). A check with the server for the visitor's current sign-in moves it between them, and sign-out or a session end moves it to anonymous. While loading, it shows a fixed-size placeholder, and a signed-in reload never passes through the anonymous state.

## Example
- **Loading:** [a same-size skeleton](skeleton.md) shows while [`GET /api/bff/session`](get-api-bff-session.md) runs.
- **Anonymous:** **Log in** and **Sign up**.
- **Signed in:** a menu with the e-mail, the role, **Dashboard**, **Orders**, **Account & security** and **Log out**.
- **Unavailable:** shown on `503` or no network. Design intent (not stated in the spec): this avoids telling a signed-in member they are signed out during an outage.

## Known gaps
- The spec does not say what the unavailable state looks like, or whether it retries the check by itself.
- The spec does not say how the mobile menu entries differ from the navbar slot.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-01, B-01
- [account-unavailable](account-unavailable.md)
- [anonymous-state](anonymous-state.md)
- [get-api-bff-session](get-api-bff-session.md)
- [navbar-menu-entry](navbar-menu-entry.md)
- [navbar-unavailable-state](navbar-unavailable-state.md)
- [navbar](navbar.md)
- [query-keys-auth-session](query-keys-auth-session.md)
- [rendering-failure](rendering-failure.md)
- [skeleton](skeleton.md)
<!-- used-by:end -->
