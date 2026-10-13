---
id: login-mfa-page
title: Login MFA page (/login/mfa)
kind: term
status: draft
aliases: [/login/mfa]
defined_for: W01-auth-account
rules_hash: f79efdec7f3f
---
# Login MFA page (/login/mfa)
## Definition
`/login/mfa` is the second step of sign-in for an account that has [two-step verification](mfa-state.md). The member enters a current authenticator code or a [recovery code](mfa-recovery-code.md) there, and the page posts it through [`POST /api/bff/session/mfa`](mfa-verify-endpoint.md). The [pending challenge](mfa-challenge.md) never appears in the URL, the DOM or script-readable storage. After success the navbar shows the account menu, and the browser goes to the validated [`returnTo`](return-to.md). A visitor who is already signed in is redirected away before the form appears.

## Example
`POST /api/bff/session` answers `200 {mfaRequired: true}`, so the browser [replaces history ↗](../sw-external-terms.md#history-replace) with `/login/mfa?returnTo=%2Faccount%2Fsecurity`. The member pastes `123 456` (illustrative), the field keeps `123456`, and **Verify** becomes enabled. If the pending sign-in has expired, the form is replaced by "Your sign-in timed out. Sign in again." with a **Back to sign in** link.

## Known gaps
- Not confirmed in the code: that the [`__Host-bff-mfa` cookie](host-bff-mfa-cookie.md) is what carries the pending challenge between the two steps. The notes only list that the cookie exists.
- The spec does not say how the member switches between the authenticator-code field and the recovery-code field.

## Used by
<!-- used-by:start -->
- [host-bff-mfa-cookie](host-bff-mfa-cookie.md)
- [mfa-challenge](mfa-challenge.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-state](mfa-state.md)
- [post-bff-session](post-bff-session.md)
<!-- used-by:end -->
