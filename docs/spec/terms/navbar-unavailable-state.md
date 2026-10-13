---
id: navbar-unavailable-state
title: Unavailable state (navbar)
kind: term
status: draft
aliases: [unavailable, unavailable state]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# Unavailable state (navbar)
## Definition
The unavailable state is one of the four states of the [account slot](account-slot.md). The others are loading, anonymous and signed in. The slot enters this state when the [session check](get-api-bff-session.md) fails with `503` or gets no network answer. [Rule W01.R-18](rule-proof.md) says this case must not show the [anonymous state](anonymous-state.md). Design intent (not stated in the spec): an outage should not tell a signed-in member they are signed out, or offer them **Log in**.

## Example
A member loads a page while the [session service](../capabilities/S01-auth-sessions.md) is down:
```
GET /api/bff/session  →  503
```
The account slot shows the "unavailable" state instead of **Log in** and **Sign up** (W01 AS-20, code: `packages/web/components/auth/account-menu.tsx#AccountSlotClient`).

## Known gaps
- The spec does not say what the slot shows in this state, such as the text, an icon or a retry control.
- The spec does not say how the slot leaves this state. It does not say whether the session check retries, or when.
- The spec does not say whether other `5xx` answers, besides `503`, also lead to this state. W01.R-18 names only `503` and no network.

## Used by
<!-- used-by:start -->
- [account-slot](account-slot.md)
- [anonymous-state](anonymous-state.md)
- [get-api-bff-session](get-api-bff-session.md)
- [navbar-menu-entry](navbar-menu-entry.md)
- [navbar](navbar.md)
- [rule-proof](rule-proof.md)
<!-- used-by:end -->
