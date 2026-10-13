---
id: request-id
title: requestId / X-Request-Id
kind: term
status: draft
aliases: [requestid, x-request-id]
defined_for: problem-json-errors
rules_hash: e43c14d3454a
---
# requestId / X-Request-Id
## Definition
`requestId` identifies one request, and every error body carries it. Support can match a client's error report to the server logs by this value. A client may send its own `X-Request-Id`, and the server keeps it only if it has the allowed length and characters and appears once. Otherwise the server replaces it with a freshly generated [UUIDv7 ↗](../sw-external-terms.md#uuidv7).

## Example
```
X-Request-Id: checkout-7f3a9c21        ← kept: valid characters, sent once
X-Request-Id: a b c                    ← replaced with a new UUIDv7
```
The error body then contains `"requestId": "checkout-7f3a9c21"` (values are illustrative).

## Known gaps
- The spec does not say whether the server echoes the final ID back in an `X-Request-Id` response header.
- The spec does not say whether the ID is forwarded to [upstream calls](upstream.md), for example through [{{resilient-http}}](resilient-http.md).
- Not confirmed in the code: the [request context](request-context.md) stores the ID and the logs use that stored value.

## Used by
<!-- used-by:start -->
- [request-context](../concepts/request-context.md): C-03
- [configure-http-app](configure-http-app.md)
- [http-pipeline](http-pipeline.md)
- [identical-registration-response](identical-registration-response.md)
- [request-context](request-context.md)
- [resilient-http](resilient-http.md)
- [upstream](upstream.md)
<!-- used-by:end -->
