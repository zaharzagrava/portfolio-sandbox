---
id: route-guard
title: Route guard
kind: term
status: draft
aliases: [guard]
defined_for: W01-auth-account
rules_hash: 3427238dd08f
---
# Route guard
## Definition
A route guard is a check in the web app that runs before a page shows and redirects the visitor based on their [session state](session-cookie.md). It works in two directions. It sends an anonymous visitor away from a [protected route](protected-route.md) to `/login`, with the original path kept in `[returnTo](return-to.md)`. It also sends a signed-in visitor away from the sign-in pages before any form appears. Guards exist only for convenience and are not a security boundary. The [BFF ↗](../sw-external-terms.md#bff) and the [owning API](domain-api-origin.md) authorize every data request again.

## Example
An anonymous visitor opens `/account/security`. The guard runs and they land on `/login?returnTo=%2Faccount%2Fsecurity` (W01.B-21). After they sign in, the validated `returnTo` takes them back to `/account/security`.
In the other direction, a signed-in member who opens `/login`, `/register`, `/forgot-password` or `/login/mfa` is redirected before the form renders (W01.R-06, `packages/web/lib/auth/guards.ts#authPageRedirect`).

## Known gaps
- The spec does not say which routes are protected besides `/account/security`.
- The spec does not say what the guard does when the session check fails with `503` or there is no network. It only says the [navbar shows the "unavailable" state](session-store.md) in that case (W01.R-18).
- Not confirmed in the code: which function does the redirect in W01.B-21. W01.R-20 cites `packages/web/lib/auth/session.server.ts#requireServerSession`, but the notes do not show that this function makes the `/login?returnTo=…` redirect.

## Used by
<!-- used-by:start -->
- [W01](../capabilities/W01-auth-account.md): B-21
- [domain-api-origin](domain-api-origin.md)
- [protected-route](protected-route.md)
- [query-keys-auth-session](query-keys-auth-session.md)
- [service-auth-guard](service-auth-guard.md)
- [session-cookie](session-cookie.md)
- [session-store](session-store.md)
<!-- used-by:end -->
