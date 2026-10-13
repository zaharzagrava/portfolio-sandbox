---
id: post-auth-login
title: POST /auth/login
kind: term
status: draft
aliases: [/auth/login]
defined_for: S01-auth-sessions
rules_hash: 5ff884cefd7b
---
# POST /auth/login
## Definition
`POST /auth/login` is the password login endpoint of [S01](../capabilities/S01-auth-sessions.md). It checks the address and password, then starts a new session with a new session ID. The tokens come back in the response body, or as cookies when the client asks for [cookie delivery](cookie-delivery.md). If the user has an enrolled [second factor](mfa-state.md), the endpoint returns an [MFA challenge](mfa-challenge.md) with an [`mfaToken`](mfa-challenge-token.md) instead of a session, and [S02](../capabilities/S02-mfa-oidc.md) completes the login. An unknown address and a wrong password both get the same `invalid_credentials` answer. The login throttle and the per-IP rate limit apply to both cases.

## Example
Right password, no cookie delivery: the response is `200` with `accessToken.expiresIn: 300`, a refresh token, a session ID and the user (S01.B-06).
After 5 failed logins for that address from different IPs, a 6th login with the right password gets `429` with `Retry-After` (S01.B-07).
A user with a stored bcrypt hash logs in successfully, and their hash is replaced with an Argon2id hash (S01.B-08).

## Known gaps
- The spec does not name the request body fields for the address and the password. Only `delivery: "cookie"` is mentioned.
- The spec does not say what the response body contains when `delivery: "cookie"` is used, for example whether the tokens also appear in the body.
- Not confirmed in the code: the facts point to `AuthController` for this route, but they name no application service that runs the login.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-04
- [cookie-delivery](cookie-delivery.md)
- [mfa-challenge](mfa-challenge.md)
- [mfa-state](mfa-state.md)
<!-- used-by:end -->
