---
id: oversized-refresh-token
title: Oversized refresh token rejection
kind: term
status: draft
aliases: [bad request, oversized value]
defined_for: access-token-session
rules_hash: a467e78c209f
---
# Oversized refresh token rejection
## Definition
[S01](../capabilities/S01-auth-sessions.md) checks the length of a [refresh token](token-refresh.md) value before it tries a [token refresh](token-refresh.md). If the value is longer than the allowed maximum, S01 rejects it at once with a `400` bad request. It does not answer with [`invalid_refresh_token`](invalid-refresh-token-error.md). A value that is too long can't be a token S01 issued, so S01 treats it as malformed input, not as a failed refresh. Rejecting it before any lookup also saves work on junk input. That reason is design intent (not stated in the spec).

## Example
A client sends a refresh with a 300-character value. The rule sets the limit at 256 characters, so S01 answers with a bad request and never looks for the token:
```
HTTP/1.1 400 Bad Request
```
(The 300-character length is illustrative. The spec names only the status, not the body.)

## Known gaps
- The spec does not say what error code or body the `400` response carries.
- The spec does not say whether [the BFF ↗](../sw-external-terms.md#bff) also enforces this length limit before it forwards a refresh to S01.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-21
- [invalid-refresh-token-error](invalid-refresh-token-error.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
