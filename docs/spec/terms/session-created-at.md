---
id: session-created-at
title: createdAt (session)
kind: term
status: draft
aliases: [createdat]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# createdAt (session)
## Definition
`createdAt` is the time a session was created at login. Each entry of [`GET /auth/sessions`](get-auth-sessions.md) returns it next to [`sessionId`](session-id.md), `device`, `ip`, [`lastUsedAt`](session-last-used-at.md) and [`current`](current-session-marker.md). [A session's total lifetime](session-lifetime.md) is counted from its creation, and a refresh does not extend it. A refresh keeps the same session, so `createdAt` should not change on refresh.

## Example
One entry in the `GET /auth/sessions` response (values are illustrative):
```json
{"sessionId": "s_7f2c", "device": "Firefox on Linux", "ip": "203.0.113.7",
 "createdAt": "2026-10-01T08:15:00Z", "lastUsedAt": "2026-10-13T09:02:11Z", "current": true}
```

## Known gaps
- The spec does not say what format or time zone `createdAt` uses. The [ISO-8601 ↗](../sw-external-terms.md#iso-8601) value in the example is an assumption.
- The spec does not say whether "newest first" in the session list is ordered by `createdAt`.
- The spec does not say whether the session lifetime limit (S01.R-22) is computed from this stored `createdAt` field.

## Used by
<!-- used-by:start -->
- [session-lifetime](session-lifetime.md)
<!-- used-by:end -->
