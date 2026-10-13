---
id: user-hash
title: userHash
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# userHash
## Definition
`userHash` is a field of the [`search.performed`](search-performed-event.md) event that identifies who searched as a hash, not as a raw identifier. [Analytics](analytics-events-topic.md) can then tell searchers apart without the event carrying a user id. That reason is design intent (not stated in the spec). The event must parse with the [search event contract](service-contract.md) in `packages/contracts`.

## Example
```json
{ "searchId": "…", "query": "blue mug", "results": 12, "mode": "lexical",
  "userHash": "9f2c…", "degraded": [], "surface": "public" }
```
(The values are illustrative.)

## Known gaps
- The spec does not say what is hashed. It may be the user id, or the [client address](client-address.md) for anonymous callers.
- The spec does not say which algorithm or [salt ↗](../sw-external-terms.md#salted-hash) is used, or whether the hash stays stable across days.
- Not confirmed in the code: the exact field type, which is defined in `packages/contracts/src/search/events.ts#searchEventSchemas`.

## Used by
<!-- used-by:start -->
- [analytics-events-topic](analytics-events-topic.md)
- [client-address](client-address.md)
- [service-contract](service-contract.md)
<!-- used-by:end -->
