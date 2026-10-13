---
id: log-capture
title: Log capture
kind: term
status: draft
aliases: [captured logs]
defined_for: S01-auth-sessions
rules_hash: 7f1d470b68ff
---
# Log capture
## Definition
Log capture is a test technique: the test records every log line the system writes while it runs a flow, then checks those lines. In S01, it runs over a full register, login, refresh, logout and password-reset flow. It checks that no log line contains a password, a token, a [CSRF value ↗](../sw-external-terms.md#csrf-token) or a [password hash](password-hash.md). Design intent (not stated in the spec): secrets must not leak through logs, which are usually copied to places with weaker access control.

## Example
A test captures logs while it runs `POST /auth/register`, `POST /auth/login`, [`POST /auth/refresh`](post-bff-session-refresh.md), [`POST /auth/logout`](post-auth-logout.md) and the two password-reset endpoints. It then searches the captured lines for the password it used, the tokens it received, the [`__Host-csrf`](host-bff-cookies.md) value and the stored hash. Every search must come back empty.

## Known gaps
- The spec does not say how the system keeps these values out of logs (for example, redaction in the logger or simply never logging them).
- The spec does not say whether other secrets are checked, such as MFA codes, recovery codes or service-to-service tokens.
- Not confirmed in the code: which test or logger setup does the capture.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-28
- [password-hash](password-hash.md)
<!-- used-by:end -->
