---
id: password-hash
title: Password hash
kind: term
status: draft
aliases: [password verification]
defined_for: S01-auth-sessions
rules_hash: 5adab6288f6f
---
# Password hash
## Definition
A password hash is the one-way, stored form of a user's password. [Argon2id ↗](../sw-external-terms.md#argon2id) is the current algorithm. A stored [bcrypt ↗](../sw-external-terms.md#bcrypt) hash or an outdated Argon2id hash still verifies, and [`PasswordHasher`](password-hasher.md) replaces it with a current Argon2id hash on the next successful login. Registration computes exactly one hash per request, for new and existing addresses alike, so [response time does not reveal membership](identical-registration-response.md). Hash work is bounded by a [concurrency limit](concurrency-limit.md) and a [queue limit](hash-queue-limit.md); extra requests get `503` with [`Retry-After: 1` ↗](../sw-external-terms.md#retry-after).

## Example
A user whose stored hash is bcrypt logs in with the right password. Login succeeds, and the stored hash becomes Argon2id (S01.B-08). A login password longer than 128 characters is rejected with `400` before any hash is computed.

## Known gaps
- The spec does not say which Argon2id parameters count as "current", or how an outdated hash is detected.
- The spec does not say the actual concurrency limit or queue limit used by [`BoundedConcurrency`](bounded-concurrency.md).

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-06, R-08, B-28
- [concurrency-limit](concurrency-limit.md)
- [hash-queue-limit](hash-queue-limit.md)
- [identical-registration-response](identical-registration-response.md)
- [invalid-credentials](invalid-credentials.md)
- [log-capture](log-capture.md)
- [password-changed-event](password-changed-event.md)
- [password-hasher](password-hasher.md)
- [secret-fields](secret-fields.md)
<!-- used-by:end -->
