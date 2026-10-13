---
id: query-keys-auth-session
title: queryKeys.auth.session()
kind: term
status: draft
aliases: [querykeys.auth.session]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# queryKeys.auth.session()
## Definition
`queryKeys.auth.session()` is the [TanStack Query key ↗](../sw-external-terms.md#tanstack-query-key) where the web app caches the result of the session check. The session check is [`GET /api/bff/session`](get-api-bff-session.md). The session is treated as server data, so the [navbar](../capabilities/W01-auth-account.md), [guards](route-guard.md) and account menu all read one shared value instead of each keeping its own copy. That value moves the [account slot](account-slot.md) between loading, [anonymous](anonymous-state.md), signed in and unavailable. W01 owns this key as part of its browser state.

## Example
On page load, the navbar's `AccountSlot` reads the session through `queryKeys.auth.session()`, which triggers `GET /api/bff/session`.
- If the check returns a user, the slot shows the account menu.
- If it returns `401`, the slot shows **Log in** and **Sign up**.
- If it returns `503` or there is no network, the slot shows the "unavailable" state, not the anonymous state.

After the member opens a shop and the page calls [`POST /api/bff/session/refresh`](post-bff-session-refresh.md), the menu shows the seller role without a reload.

## Known gaps
- The spec does not say what the key literally contains, or which file defines `queryKeys`.
- The spec does not say how the refresh call, sign-in and session end update this entry. It doesn't say whether they write the new value directly, invalidate and refetch, or remove the entry.
- The spec does not say what staleness or refetch settings this query uses.

## Used by
<!-- used-by:start -->
- [account-slot](account-slot.md)
- [anonymous-state](anonymous-state.md)
- [route-guard](route-guard.md)
<!-- used-by:end -->
