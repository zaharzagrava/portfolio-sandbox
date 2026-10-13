---
id: principal
title: Principal
kind: term
status: draft
aliases: []
defined_for: access-token-session
rules_hash: b33cb8bebc81
---
# Principal
## Definition
The principal is the caller identity that a service acts on for a request. In this system, it comes only from a [verified access token](access-token.md). Request headers or body fields that claim an identity are never used. This makes the token the single source of truth for "who is calling".

## Example
A request carries [`Authorization: Bearer <token for user A>` ↗](../sw-external-terms.md#authorization-bearer) and also [`X-User-Id: B`](x-user-id-header.md) (illustrative values). The service treats user A as the principal and ignores the header.

## Known gaps
- The spec does not say which token claim (for example [`sub` ↗](../sw-external-terms.md#jwt-sub)) holds the principal, or what other fields the principal has (roles, session id).
- The spec does not say how [service-to-service tokens](service-to-service-token.md) from S01 map to a principal, compared with user tokens.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-16
- [S48](../capabilities/S48-bff.md): R-14, R-17, B-11
- [access-token-session](../concepts/access-token-session.md): C-01
- [access-token](access-token.md)
- [edge-stripping](edge-stripping.md)
- [normalize-email](normalize-email.md)
- [parse-create-input](parse-create-input.md)
- [post-api-graphql](post-api-graphql.md)
- [protected-route](protected-route.md)
- [request-context](request-context.md)
- [service-to-service-token](service-to-service-token.md)
- [x-user-id-header](x-user-id-header.md)
<!-- used-by:end -->
