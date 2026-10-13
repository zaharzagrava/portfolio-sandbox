---
id: oidc-state
title: OIDC state
kind: term
status: draft
aliases: [state]
defined_for: S02-mfa-oidc
rules_hash: d8e4c74adecc
---
# OIDC state
## Definition
`state` is the value the system creates when an [OIDC ↗](../sw-external-terms.md#oidc) flow starts. It is sent to the provider in the [`authorizationUrl`](authorization-url.md) and comes back on the [callback](oidc-callback.md). The callback accepts a `state` only if it is known, not expired, not used before and [bound to the browser](oidc-flow-cookie.md) that started the flow. If two duplicate callbacks arrive at the same time, [only one of them wins](optimistic-concurrency.md). The `state` never appears in the callback's redirect.

## Example
A visitor calls `POST /auth/oidc/google/start` and gets an `authorizationUrl` plus a flow cookie. If the same callback URL is opened a second time (a replay), the `state` is rejected and no session is issued.

## Known gaps
- Not confirmed in the code: that the browser binding uses the `__Host-oidc-flow` cookie. The facts name that cookie but do not link it to `state`.
- The spec does not say which error code a rejected `state` produces in the redirect.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-19
- [oidc-callback](oidc-callback.md)
- [oidc-flow-cookie](oidc-flow-cookie.md)
- [oidc-start](oidc-start.md)
- [optimistic-concurrency](optimistic-concurrency.md)
<!-- used-by:end -->
