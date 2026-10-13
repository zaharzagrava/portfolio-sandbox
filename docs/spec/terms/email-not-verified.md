---
id: email-not-verified
title: email_not_verified
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# email_not_verified
## Definition
`email_not_verified` is the error code a [callback](oidc-callback.md) ends with when the provider does not report [`email_verified`](email-verified.md) as the boolean `true`. It belongs to the [closed set of callback error codes](closed-error-code.md). It is sent in the redirect and does not echo any provider text. [No account is linked](oidc-account-link.md) and no session is issued.

## Example
Illustrative, following the [`/login?error=oidc_denied`](oidc-login-error.md) pattern from the spec:
```
Location: /login?error=email_not_verified
```

## Known gaps
- The spec does not confirm the redirect path for this error. `/login?error=` is shown only for `oidc_denied`.
- The spec does not say whether this error also applies when the [`(provider, subject)`](provider-subject.md) is already linked. Rule S02.R-22 suggests that a known subject signs in regardless of e-mail.

## Used by
<!-- used-by:start -->
- [closed-error-code](closed-error-code.md)
- [oidc-account-link](oidc-account-link.md)
- [oidc-callback](oidc-callback.md)
<!-- used-by:end -->
