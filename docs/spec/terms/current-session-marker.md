---
id: current-session-marker
title: Current session marker
kind: term
status: draft
aliases: [current]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# Current session marker
## Definition
`current` is a boolean member of each item that [`GET /auth/sessions`](get-auth-sessions.md) returns. It is true for the session that made the request, so a user can see which listed session is the device they are using right now. The list holds only the caller's active sessions, newest first. Each item has only [`sessionId`](session-id.md), `device`, `ip`, [`createdAt`](session-created-at.md), [`lastUsedAt`](session-last-used-at.md) and `current`.

## Example
```json
[
  {"sessionId": "s-3", "device": "Firefox on Linux", "ip": "203.0.113.7",
   "createdAt": "2026-10-12T09:00:00Z", "lastUsedAt": "2026-10-13T08:55:00Z", "current": true},
  {"sessionId": "s-2", "device": "Safari on iOS", "ip": "198.51.100.4",
   "createdAt": "2026-10-01T18:20:00Z", "lastUsedAt": "2026-10-10T21:03:00Z", "current": false}
]
```
(All values are illustrative.)

## Known gaps
- The spec does not say how the current session is identified, for example by a session ID inside the [access token](access-token.md).
- Not confirmed in the code: whether revoking the session marked `current` through [`DELETE /auth/sessions/:sessionId`](session-revocation.md) also clears cookies the way logout does.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
<!-- used-by:end -->
