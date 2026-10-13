---
id: raw-token
title: Raw token (never stored)
kind: term
status: draft
aliases: [raw token]
defined_for: S01-auth-sessions
rules_hash: 0a7b5518b4a3
---
# Raw token (never stored)
## Definition
The raw token is the secret reset value as it appears in the link sent to the user. It must never be written to any database table, [outbox row](event-row.md) or log. Only the user's message carries it. This is design intent (not stated in the spec): someone who reads the database, the [event stream](event-backbone.md) or the logs still cannot reset a password.

## Example
The reset message contains a link with the token value. A check of the [reset-token table](password-reset-token.md), of the outbox rows the request produced, and of the request's log lines finds that value nowhere.

## [Known gaps](known-gaps.md)
- Not confirmed in the code: what is stored in place of the raw token (for example, a [digest](mfa-recovery-digest.md)) and how `confirm` matches the token it receives against that stored value.
- The spec does not say how the message carrying the raw token gets to the mail sender without going through an outbox row.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-39
- [event-backbone](event-backbone.md)
- [event-row](event-row.md)
- [known-gaps](known-gaps.md)
- [mfa-recovery-digest](mfa-recovery-digest.md)
- [password-reset-token](password-reset-token.md)
- [password-reset](password-reset.md)
<!-- used-by:end -->
