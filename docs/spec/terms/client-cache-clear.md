---
id: client-cache-clear
title: Client cache clear on sign-out
kind: term
status: draft
aliases: [cache is cleared]
defined_for: W01-auth-account
rules_hash: 78b94033dfde
---
# Client cache clear on sign-out
## Definition
When a logout succeeds, the web app clears its client-side query cache before showing the anonymous state. The session is server data held in TanStack Query under [`queryKeys.auth.session()`](query-keys-auth-session.md), so clearing the cache drops the signed-in value. The cache is only cleared after the sign-out request succeeds. If the request fails, nothing is cleared and the member stays signed in. Design intent (not stated in the spec): the next person using the browser should not see the previous member's cached data.

## Example
The member chooses **Log out** in the account menu, and [`POST /api/bff/session/logout`](post-bff-session-logout.md) succeeds. `useLogout` (`packages/web/hooks/use-auth-actions.ts`) clears the cache. The browser goes to [`/login?notice=signed_out`](signed-out-notice.md), and the navbar shows **Log in** and **Sign up**.

## Known gaps
- The spec does not say whether the whole query cache is cleared or only the session and member-specific keys.
- The spec does not say whether other open tabs also clear their caches when they receive the [`auth` BroadcastChannel event ↗](../sw-external-terms.md#broadcast-channel). It only says they show the anonymous navbar within 1 second.

## Used by
<!-- used-by:start -->
- [W01](../capabilities/W01-auth-account.md): B-20
- [post-bff-session-logout](post-bff-session-logout.md)
- [signed-out-notice](signed-out-notice.md)
<!-- used-by:end -->
