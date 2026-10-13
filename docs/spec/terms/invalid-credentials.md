---
id: invalid-credentials
title: invalid_credentials (401)
kind: term
status: draft
aliases: [invalid_credentials]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# invalid_credentials (401)
## Definition
`invalid_credentials` is the error code, with HTTP status 401, for a failed password login. An unknown address and a wrong password get the same response. Both cases also do exactly [one password verification](password-hash.md), so neither the body nor the timing shows whether the account exists. In the code it is `Domain_InvalidCredentialsError`.

## Example
`POST /auth/login` for `nobody@example.com`, and `POST /auth/login` for an existing user with the wrong password, both return `401 invalid_credentials` with the same body.

## Known gaps
- The spec does not say how the unknown-address case does its one verification (for example, against a [dummy hash](password-hash.md)).
- The spec does not say whether a [soft-deleted](soft-delete.md) or banned user also gets `invalid_credentials` at login.

## Used by
<!-- used-by:start -->
- [password-hash](password-hash.md)
- [soft-delete](soft-delete.md)
<!-- used-by:end -->
