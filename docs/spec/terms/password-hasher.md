---
id: password-hasher
title: PasswordHasher
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# PasswordHasher
## Definition
`PasswordHasher` is the [S01](../capabilities/S01-auth-sessions.md) component that computes and checks every password hash. It uses [Argon2id ↗](../sw-external-terms.md#argon2id) as the current algorithm. It still verifies an older stored hash, either [bcrypt ↗](../sw-external-terms.md#bcrypt) or an [outdated Argon2id hash](password-hash.md). After the next successful login, that hash is replaced with a current Argon2id hash. Registration calls it exactly once per request, whether the address is new or already registered. That way, response time does not reveal which addresses have accounts.

## Example
A user whose stored hash is bcrypt logs in with the right password. Login succeeds, and the stored hash is now Argon2id (S01.B-08). A login whose password is longer than the maximum length gets `400` before `PasswordHasher` runs.

## Known gaps
- The spec does not say which Argon2id parameters count as "current", or how an outdated hash is detected.
- Not confirmed in the code: whether `PasswordHasher` swaps in the new hash itself, or whether the login service does it after verification.
- Not confirmed in the code: whether `PasswordHasher` sends its work through [`BoundedConcurrency`](bounded-concurrency.md). The facts link that class to the hashing limit but don't show the call.

## Used by
<!-- used-by:start -->
- [password-hash](password-hash.md)
<!-- used-by:end -->
