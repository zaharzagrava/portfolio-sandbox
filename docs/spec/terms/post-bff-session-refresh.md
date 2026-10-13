---
id: post-bff-session-refresh
title: POST /api/bff/session/refresh
kind: term
status: draft
aliases: [/api/bff/session/refresh, refresh call]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# POST /api/bff/session/refresh
## Definition
`POST /api/bff/[session](session-lifetime.md)/refresh` asks the [BFF ↗](../sw-external-terms.md#bff) to re-issue the current session. The web app uses it to refresh the member's [role](shop-role.md) after the role changes, without a page reload. Because it is a non-`GET` call made while signed in, it must carry `[X-CSRF-Token ↗](../sw-external-terms.md#csrf-token)` equal to the [`__Host-bff-csrf` cookie](host-bff-cookies.md). Design intent (not stated in the spec): the role travels in the [tokens](access-token.md) the BFF holds, so it must get new tokens to see the new role.

## Example
A member opens a shop and becomes a seller. The page then sends:
```
POST /api/bff/session/refresh
X-CSRF-Token: <value of __Host-bff-csrf>
```
The account menu then shows the seller role without a reload.

## Known gaps
- The spec does not say what the response body contains, or whether the [`__Host-bff-session` cookie](host-bff-cookies.md) value changes.
- The spec does not say what the interface does when the refresh fails.
- The spec does not say what triggers a refresh besides opening a shop.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [host-bff-cookies](host-bff-cookies.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
