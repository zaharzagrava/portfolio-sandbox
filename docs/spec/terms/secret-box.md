---
id: secret-box
title: SecretBox
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: 71441ea07856
---
# SecretBox
## Definition
`SecretBox` is one of the services that the [identity domain](identity-domain.md) exports for other domains to use. Its name and a configured key for protecting secrets suggest that it seals secrets before storage and opens them again later. That link is not confirmed by the facts. Other domains would call it so they never handle that key themselves. This reason is design intent (not stated in the spec).

## Example
[S01](../capabilities/S01-auth-sessions.md) lists four exported services. `SecretBox` is the one that deals with secrets:
```
[UserDirectoryService](user-directory-service.md), [SessionRevocationService](session-revocation-service.md), [ServiceTokenService](service-to-service-token.md), SecretBox
```
Illustrative: a domain that must store a secret, such as an MFA factor secret, would seal it with `SecretBox` before writing it and open it when reading it back.

## Known gaps
- The spec does not say what methods `SecretBox` has, what algorithm it uses, or where its code file is.
- The spec does not say that `SecretBox` is the component that uses the "master key for secret sealing". That link comes from the names only.
- The spec does not say how sealed values behave when the master key changes, or which domains actually call `SecretBox`.

## Used by
<!-- used-by:start -->
- [identity-domain](identity-domain.md)
- [master-key](master-key.md)
<!-- used-by:end -->
