---
id: link-conflict
title: link_conflict
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# link_conflict
## Definition
`link_conflict` is an [OIDC login error code](oidc-login-error.md). It means the account the e-mail points to already holds an [identity](identity-link.md) from this provider, but with a different [subject](provider-subject.md). One account may hold only one identity per provider, and [the store enforces this](identity-store.md). So the [callback](oidc-callback.md) refuses to add a second link and signs nobody in.

## Example
The user is linked to Google subject `g-1`. A Google login arrives for subject `g-2` with the same e-mail. The callback answers `302` with `error=link_conflict`.

## Known gaps
- The spec does not say whether [explicit linking](linked-identity.md) (`POST /auth/oidc/:provider/link/start`) that hits the same conflict ends with `link_conflict` or with another code.

## Used by
<!-- used-by:start -->
- [identity-link](identity-link.md)
- [identity-store](identity-store.md)
- [linked-identity](linked-identity.md)
- [oidc-callback](oidc-callback.md)
- [oidc-login-error](oidc-login-error.md)
- [provider-subject](provider-subject.md)
<!-- used-by:end -->
