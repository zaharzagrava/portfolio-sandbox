---
id: session-not-found
title: session_not_found (404)
kind: term
status: draft
aliases: [session_not_found]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# session_not_found (404)
## Definition
`session_not_found` is the 404 error for a [session ID](session-id.md) the caller cannot act on. A session ID that belongs to another user gets [exactly the same answer](identical-not-found.md) as one that does not exist. That way a caller cannot tell whether someone else's session ID is real. This is design intent (not stated in the spec).

## Example
A user calls [`DELETE /auth/sessions/s_other`](get-auth-sessions.md) with the ID of another user's session (illustrative). The answer is `404 session_not_found`, the same as for `DELETE /auth/sessions/s_doesnotexist`.

## Known gaps
- The spec does not say what [revoking](session-revocation.md) your own already-revoked session returns: `404 session_not_found` or a repeat success. [Logout is idempotent ↗](../sw-external-terms.md#idempotency) (`204` twice), but nothing is said about this route.

## Used by
<!-- used-by:start -->
- [identical-not-found](identical-not-found.md)
- [session-id](session-id.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
