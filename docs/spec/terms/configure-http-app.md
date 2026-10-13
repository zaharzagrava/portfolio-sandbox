---
id: configure-http-app
title: configureHttpApp
kind: term
status: draft
aliases: []
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# configureHttpApp
## Definition
`configureHttpApp` is the shared function that sets up the [HTTP pipeline](http-pipeline.md) for a backend app. The pipeline is the chain of steps every incoming HTTP request passes through. `configureHttpApp` works with [`bootstrapApp`](bootstrap-app.md): `bootstrapApp` handles startup, and `configureHttpApp` handles the HTTP side. Because it is shared, every app with an [HTTP surface](http-surface.md) handles requests the same way and product teams don't build their own pipeline. Parts of this pipeline that appear on the page are the [load-shedding gate](load-shedding.md) (which runs first), [request context](request-context.md) and [requestId](request-id.md) handling, and the [problem exception filter](problem-exception-filter.md).

## Example
A route in an app built on the shared pipeline throws a plain `TypeError` (S54.B-02). The client receives:
```json
{ "status": 500, "code": "internal_error", "detail": "An unexpected error occurred.", "requestId": "…" }
```
The request ID value is omitted here. The full body also contains `type`, `title` and `instance`.

## Known gaps
- Not confirmed in the code: which parts of the pipeline `configureHttpApp` registers itself, and in what order. The only order the spec gives is that the load-shedding gate runs first.
- Not confirmed in the code: where `configureHttpApp` is defined. The only code reference is `packages/backend/libs/infrastructure/lifecycle/startup.ts#bootstrapApp`.
- The spec does not say whether apps without an HTTP server skip `configureHttpApp`. One example is the worker in S54.B-15, which shuts down "without HTTP steps".

## Used by
<!-- used-by:start -->
- [http-pipeline](http-pipeline.md)
- [http-surface](http-surface.md)
- [load-shedding](load-shedding.md)
- [problem-exception-filter](problem-exception-filter.md)
- [request-context](request-context.md)
- [request-id](request-id.md)
<!-- used-by:end -->
