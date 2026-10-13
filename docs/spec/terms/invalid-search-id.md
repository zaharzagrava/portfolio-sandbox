---
id: invalid-search-id
title: invalid_search_id (422)
kind: term
status: draft
aliases: [invalid_search_id]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# invalid_search_id (422)
## Definition
`invalid_search_id` is the error code that `POST /search/clicks` returns with status `422` when the `searchId` cannot be trusted. That covers a `searchId` that is forged, altered, expired or missing. The `searchId` is signed and carries the query of the search it came from. That lets the click be tied to its query without trusting anything else the client sends. Other bad fields, such as a `position` out of range, answer `400 validation_failed` instead.

## Example
```json
POST /search/clicks
{ "searchId": "tampered-value", "productId": "prod_42", "position": 3 }
→ 422 { "code": "invalid_search_id", ... }
```
(The values are illustrative.)

## Known gaps
- The spec does not say how long a `searchId` stays valid before it counts as expired.
- The spec does not say which response field gives the client its `searchId`.
- The spec does not say whether a click with a bad `searchId` is still counted in a metric.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
