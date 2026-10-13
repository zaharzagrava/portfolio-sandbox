---
id: http-pipeline
title: HTTP pipeline
kind: term
status: draft
aliases: [pipeline, shared pipeline]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# HTTP pipeline
## Definition
The HTTP pipeline is the fixed chain of steps that every incoming HTTP request passes through before and after its route handler. [`configureHttpApp`](configure-http-app.md) builds this chain the same way for every app, so product teams do not assemble their own. The [load-shedding gate](load-shedding.md) is the first step. The pipeline also creates the [request context](request-context.md) and resolves the [requestId](request-id.md). The [problem exception filter](problem-exception-filter.md) turns any error into a [problem+json ↗](../sw-external-terms.md#problem-json) response. Design intent (not stated in the spec): with one shared chain, every app handles overload, request IDs and errors the same way.

## Example
A client calls a route without an `X-Request-Id` header (S54.B-04). The load-shedding gate checks the request first. A [UUIDv7 ↗](../sw-external-terms.md#uuidv7) is then created and appears in the response header, the logs and the request context. If the handler throws, the same ID also appears in the error body:
```
X-Request-Id: 0192f3a4-7b1c-7d2e-9f00-1a2b3c4d5e6f   (illustrative value)
```

## Known gaps
- The spec does not say the full order of the steps. It only says the load-shedding gate runs first.
- The spec does not say whether some configured settings are pipeline steps: body size and media-type checks, server timeouts, trusted proxies and the CORS allowlist. Their error codes (`413 payload_too_large`, `415 unsupported_media_type`) are defined, but no pipeline step is named for them.
- The spec does not say whether probes served by the [management listener](management-listener.md) go through this pipeline. This matters for apps without an HTTP surface.

## Used by
<!-- used-by:start -->
- [configure-http-app](configure-http-app.md)
- [load-shedding](load-shedding.md)
- [management-listener](management-listener.md)
- [problem-exception-filter](problem-exception-filter.md)
- [request-context](request-context.md)
- [request-id](request-id.md)
<!-- used-by:end -->
