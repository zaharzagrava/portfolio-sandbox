---
id: navbar-menu-entry
title: Mobile menu entry
kind: term
status: draft
aliases: [entry, menu entries, mobile menu entries]
defined_for: W01-auth-account
rules_hash: 0feeaa0b1daf
---
# Mobile menu entry
## Definition
A mobile menu entry is an account item in the navbar's mobile menu. On small screens, these entries do the job of the [account slot](account-slot.md). The spec lists them together with the account slot as one [entry point](entry-point.md), so they show the same account state. That state comes from asking the server who is signed in, and it is stored under [`queryKeys.auth.session()`](query-keys-auth-session.md), which holds the session once as [server data ↗](../sw-external-terms.md#tanstack-query-key). Every consumer therefore sees the same value.

## Example
An anonymous visitor on a phone opens the mobile menu. Per W01.B-15, the navbar shows **Log in** and **Sign up**. The mobile entries are expected to match, but the spec does not say this directly. After sign-in, the account menu shows **Dashboard**, **Orders**, **Account & security** and **Log out** (W01.B-16).

## Known gaps
- The spec does not say which items the mobile menu shows in each account state. It only lists "mobile menu entries" next to the account slot.
- The spec does not say whether the mobile entries mirror the full account menu (e-mail, role and links), or only some of it.
- The spec does not say what the mobile entries show in the loading state or the "[unavailable](navbar-unavailable-state.md)" state.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-05, B-02
- [account-slot](account-slot.md)
- [entry-point](entry-point.md)
- [get-api-bff-session](get-api-bff-session.md)
- [is-admin](is-admin.md)
- [navbar-unavailable-state](navbar-unavailable-state.md)
- [navbar](navbar.md)
- [presentation-only](presentation-only.md)
<!-- used-by:end -->
