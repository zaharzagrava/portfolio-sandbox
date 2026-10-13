---
id: login-page
title: Login page (/login)
kind: term
status: draft
aliases: [/login, sign-in page]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# Login page (/login)
## Definition
`/login` is the web page where a visitor signs in with e-mail and password. It reads the [`returnTo`](return-to.md), [`notice`](login-notice.md) and [`error`](oidc-login-error.md) query parameters. It shows **Continue with Google** only when [the provider list](get-auth-oidc-providers.md) contains `google` and [`AUTH_OIDC_ENABLED`](auth-oidc-enabled.md) is true. Sign-in goes through [the BFF ↗](../sw-external-terms.md#bff), and the form does not use a Server Action. A signed-in visitor who opens this page is redirected before the form is shown.

## Example
An anonymous visitor opens `/account/security` and is sent to `/login?returnTo=%2Faccount%2Fsecurity`. They enter correct credentials and press **Sign in**. The navbar shows the account menu, and the browser lands on `/account/security` with history replaced. If the account uses [two-step verification](mfa-challenge.md), the browser goes to `/login/mfa?returnTo=…` instead.

## Known gaps
- The spec does not list the values of the `error` parameter or the text each one shows.
- The spec does not say where a signed-in visitor is redirected when they open `/login`. It may be the validated `returnTo` or `/`.

## Used by
<!-- used-by:start -->
- [get-auth-oidc-providers](get-auth-oidc-providers.md)
- [mfa-challenge](mfa-challenge.md)
<!-- used-by:end -->
