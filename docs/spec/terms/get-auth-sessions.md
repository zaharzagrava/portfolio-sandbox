---
id: get-auth-sessions
title: GET /auth/sessions
kind: term
status: draft
aliases: [/auth/sessions]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# GET /auth/sessions
## Definition
`GET /auth/sessions` lists the caller's own [active sessions](session-lifetime.md), newest first. Each entry has exactly the members [`sessionId`](session-id.md), `device`, `ip`, `createdAt`, `lastUsedAt` and [`current`](current-session-marker.md), and nothing else. `current` marks the session that made the request. The companion route `DELETE /auth/sessions/:sessionId` [revokes](session-revocation.md) one listed session. It is a [sensitive route](sensitive-route.md).

## Example
```json
[
  {"sessionId": "s_9f2c", "device": "Firefox on Linux", "ip": "203.0.113.7",
   "createdAt": "2026-10-12T08:00:00Z", "lastUsedAt": "2026-10-13T09:30:00Z", "current": true}
]
```
(All values are illustrative.)

## Known gaps
- The spec does not say how `device` is derived or what format it has.
- The spec does not say whether the list is [paginated](pagination-cursor.md). At most 20 sessions can be active at once.
- The spec does not say whether `GET /auth/sessions` itself is a sensitive route. Only the `DELETE` route is called sensitive.

## Used by
<!-- used-by:start -->
- [pagination-cursor](pagination-cursor.md)
- [sensitive-route](sensitive-route.md)
- [session-lifetime](session-lifetime.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
