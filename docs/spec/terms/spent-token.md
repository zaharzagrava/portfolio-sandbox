---
id: spent-token
title: Spent token
kind: term
status: draft
aliases: [spent]
defined_for: S01-auth-sessions
rules_hash: 38f384b55dc8
---
# Spent token
## Definition
A spent token is a single-use token that has already been used once, so the system no longer accepts it. In this system it applies to password reset tokens and to refresh tokens. When `POST /auth/password-reset/confirm` gets a spent password reset token, it returns `invalid_reset_token`, the same answer it gives for an unknown or expired token. During [refresh token rotation](refresh-token-rotation.md), each successful refresh spends the old refresh token. If anyone presents that spent refresh token again, the system [revokes the whole session](session-revocation.md). Design intent (not stated in the spec): a spent refresh token showing up again suggests it was stolen, so the session is ended to lock out the thief.

## Example
1. A client calls [`POST /auth/refresh`](post-auth-refresh.md) with refresh token `rt-A` and gets back `rt-B`. `rt-A` is now spent.
2. Later, someone calls `POST /auth/refresh` with `rt-A` again. The session is revoked, and `rt-B` stops working as well.

(Token values are illustrative.)

## Known gaps
- The spec does not say which status and error code the caller receives when presenting a spent refresh token. It says only that the session is revoked. S01.R-21 lists unknown, expired, revoked and deleted-user failures, but it does not list spent tokens.
- The spec does not say whether the `auth.purge-reset-tokens` job removes spent reset tokens, expired ones, or both.
- Not confirmed in the code: how the system marks a password reset token as spent, or what happens when two confirm requests use the same reset token at the same moment.

## Used by
<!-- used-by:start -->
- [invalid-reset-token](invalid-reset-token.md)
- [password-reset-token](password-reset-token.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
