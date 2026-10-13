---
id: secret-box-context
title: SecretBox context binding
kind: term
status: draft
aliases: [context]
defined_for: S01-auth-sessions
rules_hash: 9e83925320c7
---
# SecretBox context binding
## Definition
Every value that [`SecretBox`](secret-box.md) seals is bound to a context, and opening the value with any other context fails. For signing keys, the context is the key's [`kid` ↗](../sw-external-terms.md#jwt-kid). A [sealed](seal-context.md) private key copied onto another key's record therefore cannot be opened, which is design intent (not stated in the spec). A wrong context is one of three failures `SecretBox` detects; the other two are [tampering ↗](../sw-external-terms.md#message-authentication-code) and a wrong [master key](master-key.md).

## Example
The private part of key `kid=A` (illustrative) is sealed with context `A`. A later attempt to open it with context `B` is refused, even though the master key is correct.

## Known gaps
- The spec does not say what context other domains should use. `SecretBox` is exported to them, but the spec defines only the signing-key binding.
- The spec does not say how a failure is reported to the caller, for example which error is thrown.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-36
- [master-key](master-key.md)
- [seal-context](seal-context.md)
<!-- used-by:end -->
