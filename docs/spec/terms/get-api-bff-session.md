---
id: get-api-bff-session
title: GET /api/bff/session
kind: term
status: draft
aliases: [/api/bff/session, session check]
defined_for: W01-auth-account
rules_hash: 974096ff0f3a
---
# GET /api/bff/session
## Definition
`GET /api/bff/session` is the session check. The web app calls it to learn whether the browser is signed in. Its answer feeds the [navbar account slot](navbar.md). A returned user means signed in, `401` means anonymous, and `503` or no network means unavailable. Like every `GET`, it carries no [`X-CSRF-Token` header ↗](../sw-external-terms.md#csrf-token). The web app caches the result under [`queryKeys.auth.session()`](query-keys-auth-session.md), so all consumers share one value.

## Example
On page load, [`AccountSlot`](account-slot.md) triggers `GET /api/bff/session` with the [`__Host-bff-session` cookie](host-bff-cookies.md).
- The answer is a user, so the menu shows that user's e-mail and role.
- The answer is `401`, so the navbar shows **Log in** and **Sign up**.
- The answer is `503`, so the slot shows "unavailable", not the anonymous state.

## Known gaps
- The spec does not say what the response body contains for a signed-in user, beyond the e-mail and role that the menu shows.
- The spec does not say which of S01, S02 and S48 owns this endpoint. It lists all three for `/api/bff/session*`.
- The spec does not say whether the check extends the session lifetime.

## Used by
<!-- used-by:start -->
- [account-slot](account-slot.md)
- [anonymous-state](anonymous-state.md)
- [host-bff-cookies](host-bff-cookies.md)
- [navbar-menu-entry](navbar-menu-entry.md)
- [navbar-unavailable-state](navbar-unavailable-state.md)
- [navbar](navbar.md)
<!-- used-by:end -->
