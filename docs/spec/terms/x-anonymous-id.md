---
id: x-anonymous-id
title: X-Anonymous-Id
kind: term
status: draft
aliases: [anonymous request]
defined_for: bff-aggregate
rules_hash: 189d88174a2b
---
# X-Anonymous-Id
## Definition
`X-Anonymous-Id` is a request header that identifies a visitor who is not signed in. The [BFF ↗](../sw-external-terms.md#bff) checks it against a fixed format in `credentials/credentials.ts`. If the value does not match, the BFF drops it and treats the request as if the header were absent. A dropped value is never forwarded to an [upstream](upstream.md).

## Example
The pattern is `ANONYMOUS_ID = /^[A-Za-z0-9_-]{8,64}$/`.
- `X-Anonymous-Id: a1b2c3d4e5` (illustrative) matches, so it is kept.
- `X-Anonymous-Id: <script>` matches nothing, so it is dropped.

## Known gaps
- The spec does not say who creates the anonymous ID (the client or the BFF) or how long it lives.
- The spec does not say what upstreams use a valid anonymous ID for.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-10, R-20
- [W01](../capabilities/W01-auth-account.md): R-03
- [bff-aggregate](../concepts/bff-aggregate.md): C-08
- [session-store](session-store.md)
- [upstream](upstream.md)
<!-- used-by:end -->
