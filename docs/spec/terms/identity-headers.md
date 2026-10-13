---
id: identity-headers
title: Identity headers
kind: term
status: draft
aliases: [x-shop-id, x-tenant-id, x-user-id, x-user-role]
defined_for: bff-aggregate
rules_hash: e3f203baa577
---
# Identity headers
## Definition
Identity headers are the request headers `X-User-Id`, `X-User-Role`, `X-Tenant-Id` and `X-Shop-Id`, which name a user, role, tenant or shop. [The BFF ↗](../sw-external-terms.md#bff) must never forward them, or a `Cookie` header, to any [upstream](upstream.md), because a browser could forge them and a [domain API](domain-api-origin.md) might trust them. That reason is design intent (not stated in the spec). Upstreams learn who the caller is only from the credential the BFF itself attaches to each call it makes to them.

## Example
A client sends a page request to the BFF with these headers:
```
X-User-Id: 42            (illustrative)
X-Shop-Id: shop-7        (illustrative)
```
The BFF's calls to the domain APIs for the product, shop and other [sections](section.md) carry neither header.

## Known gaps
- The spec does not say whether the BFF rejects a client request that carries these headers, or just drops them quietly.
- The spec does not say which component, if any, is allowed to set these headers for the domain APIs.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-16
- [access-token](access-token.md)
- [bff-forwarder](bff-forwarder.md)
- [domain-api-origin](domain-api-origin.md)
- [edge-stripping](edge-stripping.md)
- [section](section.md)
- [service-to-service-token](service-to-service-token.md)
- [tenant](tenant.md)
- [upstream](upstream.md)
- [x-user-id-header](x-user-id-header.md)
<!-- used-by:end -->
