---
id: credential
title: Credential (request)
kind: term
status: draft
aliases: [any credential, credentials]
defined_for: S48-bff
rules_hash: 0a1eaa3c6519
---
# Credential (request)
## Definition
A credential is anything on an incoming request that identifies a signed-in principal. For the [BFF ↗](../sw-external-terms.md#bff), that means a [session cookie](session-cookie.md) or an [`Authorization` header ↗](../sw-external-terms.md#authorization-bearer). A request with a credential always gets a [`private, no-store` ↗](../sw-external-terms.md#cache-control-no-store) response and is never put in the [shared cache ↗](../sw-external-terms.md#shared-cache). A request that carries both kinds at once is rejected with [`ambiguous_credentials`](ambiguous-credentials.md). A cookie credential also requires a [CSRF token ↗](../sw-external-terms.md#csrf-token) on POST.

## Example
- `Cookie: __Host-bff-session=…` and no `Authorization` header: the request is credentialed, and the response is `private, no-store`.
- `Cookie: __Host-bff-session=…` together with `Authorization: Bearer …`: the BFF answers `400 ambiguous_credentials`.

## Known gaps
- The spec does not say whether an `X-Anonymous-Id` header counts as a credential when choosing between public and private caching.
- The spec does not say how GraphQL treats credentials and CSRF. AS-42 is tested but is not written down as a rule.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-30
- [S03](../capabilities/S03-shops-rbac.md): R-02
- [S48](../capabilities/S48-bff.md): B-12
- [S50](../capabilities/S50-rate-limiter.md): B-10
- [S51](../capabilities/S51-realtime-push.md): R-18, R-29
- [persisted-query-hash](persisted-query-hash.md)
- [post-auth-logout](post-auth-logout.md)
- [session-cookie](session-cookie.md)
- [trusted-document-allowlist](trusted-document-allowlist.md)
<!-- used-by:end -->
