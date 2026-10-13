---
id: session-issuer
title: SessionIssuer
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# SessionIssuer
## Definition
`SessionIssuer` is the identity-domain service that creates a new session for a user. It also enforces the [per-user cap on active sessions](session-limit.md). When a new session would take the user over that cap, it revokes the user's oldest active session with reason [`session_limit`](session-limit.md). That revoked session's [refresh token](token-refresh.md) then stops working.

## Example
A user who already has 20 active sessions signs in through `POST /auth/login`. `SessionIssuer` creates the 21st session and revokes the oldest one with reason `session_limit`. The login still succeeds.

## Known gaps
- The spec does not say whether "oldest" means the earliest [`createdAt`](session-created-at.md) or the least recent [`lastUsedAt`](session-last-used-at.md).
- The spec does not say which flows call `SessionIssuer`. For example, it does not say whether the second-factor completion in S02 calls it, or only password login does.
- Not confirmed in the code: whether `SessionIssuer` generates the new session ID that every login must get (S01.R-13). The spec cites `SessionIssuer` only for the session limit.

## Used by
<!-- used-by:start -->
- [session-limit](session-limit.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
