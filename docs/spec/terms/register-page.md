---
id: register-page
title: Register page (/register)
kind: term
status: draft
aliases: [/register]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# Register page (/register)
## Definition
`/register` is the web page where a visitor creates an account with an e-mail address and a password. The form checks the confirmation field and the terms box in the browser and sends only `email` and `password`. A new address and an existing address get the same result, so the page [never reveals whether an account exists](identical-registration-response.md). [Server validation errors](validation-failed-error.md) appear under the matching fields. A visitor who is already signed in is [redirected ↗](../sw-external-terms.md#http-302-found) before the form appears.

## Example
A visitor fills in `ana@example.com` (illustrative), a valid password, a matching confirmation and ticks the terms, then presses **Create account**:
```json
{ "email": "ana@example.com", "password": "<the password>" }
```
One request goes out, and the browser goes to [`/login?notice=registered`](login-notice.md). If the server answers [`422 weak_password`](weak-password.md), the message shows under the password field.

## Known gaps
- The spec does not say which backend path the form posts to. It only lists `/api/auth/*` as used, and every call must be a [same-origin ↗](../sw-external-terms.md#same-origin-policy) `/api/…` URL.
- The spec does not say what text the `registered` banner on `/login` shows.

## Used by
<!-- used-by:start -->
- [identical-registration-response](identical-registration-response.md)
- [validation-failed-error](validation-failed-error.md)
<!-- used-by:end -->
