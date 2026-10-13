---
id: refresh-token-rotation
title: Refresh token rotation (spent token)
kind: term
status: draft
aliases: [spend, spent token]
defined_for: access-token-session
rules_hash: 0dc7df2fb2d4
---
# Refresh token rotation (spent token)
## Definition
Refresh-token rotation means each [refresh token](token-refresh.md) works only once. A successful refresh replaces it with a new one and marks the old one as spent. If anyone presents a spent token again, [S01](../capabilities/S01-auth-sessions.md) [revokes the whole session](session-revocation.md). When two [exchanges](token-refresh.md) of the same token happen at the same moment, exactly one of them succeeds. Treating reuse as a sign that the token was stolen and copied is design intent (not stated in the spec).

## Example
1. A client exchanges refresh token `R1` and gets `R2`. `R1` is now spent.
2. Later, an attacker who copied `R1` tries to exchange it.
3. S01 sees that `R1` is spent and revokes the session, so `R2` stops working too.
(`R1` and `R2` are illustrative names.)

## Known gaps
- The spec does not say whether the losing request in a race between two simultaneous exchanges counts as spent-token reuse and revokes the session.
- The spec does not say what response the caller gets when it presents a spent token.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-20, R-23
- [S02](../capabilities/S02-mfa-oidc.md): R-11, B-07
- [W01](../capabilities/W01-auth-account.md): B-13
- [access-token-session](../concepts/access-token-session.md): C-05
- [invalid-refresh-token-error](invalid-refresh-token-error.md)
- [service-to-service-token](service-to-service-token.md)
- [session-revocation](session-revocation.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
