---
id: identity-not-found
title: identity_not_found (404)
kind: term
status: draft
aliases: [identity_not_found]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# identity_not_found (404)
## Definition
`identity_not_found` is the 404 error code of [`DELETE /auth/identities/:identityId`](linked-identity.md). It answers the same way whether the identity does not exist or belongs to another user. A caller therefore cannot tell which case applies. Design intent (not stated in the spec): this keeps callers from probing other users' identity ids.

## Example
```
DELETE /auth/identities/<an identity id of another user>   (illustrative)
→ 404 identity_not_found
```

## Known gaps
- The spec does not say what happens when a user [unlinks their only identity](identity-link.md) and has no password, as with a Google-created user.
- The spec does not say the full body for this error. The [error-schema scenarios (AS-59 to AS-66)](error-catalogue.md) have no test with a scenario id.

## Used by
<!-- used-by:start -->
- [error-catalogue](error-catalogue.md)
- [identity-link](identity-link.md)
<!-- used-by:end -->
