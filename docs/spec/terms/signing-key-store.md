---
id: signing-key-store
title: Signing key store
kind: term
status: draft
aliases: [key store]
defined_for: S01-auth-sessions
rules_hash: ab6d98b5829d
---
# Signing key store
## Definition
The signing key store is the persistent place where S01 keeps its signing keys and their states ([NEXT, ACTIVE, RETIRED](signing-key-states.md)). The [JWKS ↗](../sw-external-terms.md#jwks) is built from the keys held in it. The [rotation job](key-rotation-job.md) adds keys to it and removes old RETIRED keys. Even when several requests [race ↗](../sw-external-terms.md#race-condition) to create the first key in an empty store, exactly one ACTIVE key must result.

## Example
The rotation job runs and finds a RETIRED key that was retired 25 h ago. It deletes that key from the store, so the key also disappears from `GET /.well-known/jwks.json`, and tokens signed with it now get `401`. A key retired 23 h ago stays.

## Known gaps
- The spec does not say which technology backs the store, such as a database table or a secret manager.
- Not confirmed in the code: which mechanism (a lock, [a unique constraint ↗](../sw-external-terms.md#unique-constraint) or a transaction) makes sure only one ACTIVE key exists when first uses race.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-24
- [key-rotation-job](key-rotation-job.md)
- [key-set-forced-reload](key-set-forced-reload.md)
- [signing-key-states](signing-key-states.md)
<!-- used-by:end -->
