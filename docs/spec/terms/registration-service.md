---
id: registration-service
title: RegistrationService
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# RegistrationService
## Definition
`RegistrationService` is the [application service ↗](../sw-external-terms.md#application-service) in the [identity domain](identity-domain.md) that does the work behind [`POST /auth/register`](post-auth-register.md). Rule S01.R-01 points to it. It gives the same accepted response for a new address and an existing one, and [it never creates a session](session-cookie.md). The goal, stated in the spec's decisions, is that neither the response nor its timing shows whether an address is registered. For that reason registration computes exactly one password hash per request, whether the address is new or not.

## Example
Two requests to `POST /auth/register` both get `202 {"status":"accepted"}` with no tokens:
- The first registers `new@example.com` as a new account. It produces `identity.user_registered`.
- The second sends `New@Example.com` again. The existing account is left unchanged, and it presumably produces [`identity.registration_duplicate_attempted`](registration-duplicate-attempted-event.md). That pairing is inferred from the event name and not confirmed.

## Known gaps
- Not confirmed in the code: which registration rules live inside `RegistrationService` and which happen elsewhere. Those rules are the password policy, the breached-password check and its timeout fallback, rate limiting, and event publishing. The spec links only S01.R-01 to this service.
- The spec does not say what happens for the owner of an existing address on a duplicate attempt. For example, it does not say whether they are notified, or who consumes `identity.registration_duplicate_attempted`.
- The spec does not say how "exactly one account" is enforced when two registrations for one address arrive at the same time. It could be a database constraint, a transaction, or a lock.

## Used by
<!-- used-by:start -->
- [identity-domain](identity-domain.md)
- [session-cookie](session-cookie.md)
<!-- used-by:end -->
