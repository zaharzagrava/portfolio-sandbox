---
id: x-read-source-header
title: X-Read-Source header
kind: term
status: draft
aliases: [x-read-source]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# X-Read-Source header
## Definition
`X-Read-Source` is a response header set by the [read-your-writes helper](read-your-writes.md). It tells the caller where the answer came from. The value [`read-model`](read-model.md) means the [projection ↗](../sw-external-terms.md#projection) was fresh enough to answer. The value [`write-model`](write-model.md) means the route waited for the [read wait timeout](read-wait-timeout.md), the projection was still behind, and the route fell back to the write model.

## Example
```
HTTP/1.1 200 OK
X-Read-Source: write-model
```
This is the response after a projection stopped at version 6 and the client requested [`minVersion=7`](min-version.md).

## Known gaps
- The spec does not say whether the header is also sent on the `202` ("pending") answer or on the `400` and `404` answers.

## Used by
<!-- used-by:start -->
- [read-wait-timeout](read-wait-timeout.md)
- [read-your-writes](read-your-writes.md)
<!-- used-by:end -->
