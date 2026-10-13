---
id: email-verified
title: email_verified
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: 416b8ec25e0f
---
# email_verified
## Definition
`email_verified` is a claim in the provider's [ID token ↗](../sw-external-terms.md#oidc-id-token) that says whether the provider has verified the user's e-mail address. The system links an account by e-mail only when this claim is the boolean `true`. Any other value ends the [callback](oidc-callback.md) with [`email_not_verified`](email-not-verified.md). [Dynamic providers from S03](dynamic-provider.md) never link by e-mail, whatever this claim says. A login for an already linked [`(provider, subject)`](provider-subject.md) signs in by subject and does not depend on the e-mail.

## Example
```json
{ "sub": "g-1", "email": "ana@example.com", "email_verified": true }
```
This allows linking to an existing password account with that e-mail. The same token with `"email_verified": "true"` (a string) does not.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-15, B-24
- [dynamic-provider](dynamic-provider.md)
- [oidc-callback](oidc-callback.md)
<!-- used-by:end -->
