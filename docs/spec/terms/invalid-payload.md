---
id: invalid-payload
title: invalid_payload (400)
kind: term
status: draft
aliases: [invalid_payload]
defined_for: S10-cart-checkout
rules_hash: 24e3a227514b
---
# invalid_payload (400)
## Definition
`invalid_payload` is the bad-request answer `POST /webhooks/stripe` gives when a body passes the signature check but cannot be used. That covers two cases: the body is not valid JSON, or it is missing the `id` and `type` fields. Bodies over the size cap are rejected separately with `413`, not with this code.

## Example
A request to `POST /webhooks/stripe` has a valid signature, but its body is `{"data": {}}` with no `id` or `type`. The server answers `400 invalid_payload`.

## Known gaps
- The spec does not say whether a request rejected with `invalid_payload` is stored anywhere. That matters for debugging, because without an `id` the request cannot go into the normal event store.
- The spec does not say what status a body with a *bad* signature gets, so it is unclear how that case differs from this one.
- The spec does not say whether it is enough for one of `id` or `type` to be missing, or whether both must be missing. "lacks `id` and `type`" can be read either way.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-05
<!-- used-by:end -->
