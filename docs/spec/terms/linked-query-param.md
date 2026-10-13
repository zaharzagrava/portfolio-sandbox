---
id: linked-query-param
title: linked query parameter
kind: term
status: draft
aliases: [?linked=google]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# linked query parameter
## Definition
The linked query parameter is added to the [front-end redirect](front-end-origin.md) after an [explicit account-linking flow](oidc-account-link.md) finishes successfully. Its value names the provider whose identity was just linked to the signed-in user. It tells the front end that a link was made, not a login. [No new session is issued](session-lifetime.md), so the user keeps the session they already had. Like every [callback redirect](oidc-callback.md), it carries no token, code, state or e-mail.

## Example
A signed-in user calls `POST /auth/oidc/google/link/start`, signs in at Google, and Google redirects to `GET /auth/oidc/google/callback`. The callback answers:
```
302 Found
Location: <front-end origin>/<return path>?linked=google   (path illustrative)
Cache-Control: no-store
Referrer-Policy: no-referrer
```

## Known gaps
- The spec does not say which path the linked redirect goes to: the [`returnTo`](return-to.md) value from link start, or a fixed page.
- The spec does not say if the value is always the URL `:provider` segment, or what it is for [dynamic providers](dynamic-provider.md) from S03.
- The spec does not say how a failed link is reported. From the other behaviours it is probably an `error=` code such as `link_conflict`, but this is not confirmed.

## Used by
<!-- used-by:start -->
- [dynamic-provider](dynamic-provider.md)
- [front-end-origin](front-end-origin.md)
- [oidc-account-link](oidc-account-link.md)
- [oidc-callback](oidc-callback.md)
- [session-lifetime](session-lifetime.md)
<!-- used-by:end -->
