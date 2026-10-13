---
id: registration-duplicate-attempted-event
title: identity.registration_duplicate_attempted event
kind: term
status: draft
aliases: [identity.registration_duplicate_attempted]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# identity.registration_duplicate_attempted event
## Definition
`identity.registration_duplicate_attempted` is an event that [S01](../capabilities/S01-auth-sessions.md) publishes when a registration targets an address that already has an account. The caller still gets the [identical registration response](identical-registration-response.md), and the account is not changed. So this event is the only signal inside the system that a duplicate attempt happened. Other parts of the system can react to it without the HTTP response giving anything away (design intent (not stated in the spec)).

## Example
Two registrations for `new@example.com` arrive at the same moment. Both get `202 {"status":"accepted"}`. Afterwards one account exists, plus one `identity.user_registered` event and one `identity.registration_duplicate_attempted` event.

## Known gaps
- The spec does not say what fields the [event payload](event-payload.md) has, or which domains consume the event.
- The spec does not say whether a registration that is rejected first ([`weak_password`](weak-password.md), [`validation_failed`](validation-failed-error.md), [rate limited](rate-limit.md)) still emits the event for an existing address.
- Not confirmed in the code: which class publishes the event. The facts link registration only to [`RegistrationService`](registration-service.md).

## Used by
<!-- used-by:start -->
- [event-payload](event-payload.md)
- [identical-registration-response](identical-registration-response.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
