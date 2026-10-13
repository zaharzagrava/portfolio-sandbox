---
id: service-to-service-token
title: Service-to-service token
kind: term
status: draft
aliases: [service tokens]
defined_for: access-token-session
rules_hash: 0ea47a6d51a3
---
# Service-to-service token
## Definition
A service-to-service token is a token that [S01](../capabilities/S01-auth-sessions.md) issues for calls between backend services. S01 lists it as one of its features, next to [sessions](session-lifetime.md), [refresh-token rotation](refresh-token-rotation.md) and [JWKS ↗](../sw-external-terms.md#jwks). It lets one service prove its identity to another, the same way an [access token](access-token.md) does for a user. Design intent (not stated in the spec): the receiving service can then trust the calling service without a shared secret, because it checks the token with S01's keys.

## Example
One backend service calls another and sends the token in the header (the service names and value are illustrative):
```
Authorization: Bearer <service-to-service token issued by S01>
```
[`Authorization: Bearer` ↗](../sw-external-terms.md#authorization-bearer) is the only allowed carrier that fits a call between servers. The [`__Host-access` cookie](host-access-cookie.md) is the only other one.

## Known gaps
- The spec does not say how a service-to-service token maps to a [principal](principal.md), or how a service tells it apart from a user's access token.
- The spec does not say how long it lasts, or whether it follows the access-token rules (the 300 s expiry and the [`invalid_token`](invalid-token-error.md) checks).
- The spec does not say whether it is verified with the same JWKS keys, or which services use it.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [host-access-cookie](host-access-cookie.md)
- [identity-domain](identity-domain.md)
- [identity-headers](identity-headers.md)
- [principal](principal.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [session-lifetime](session-lifetime.md)
<!-- used-by:end -->
