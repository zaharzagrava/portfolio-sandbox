---
id: platform-toolkit
title: Platform toolkit
kind: term
status: draft
aliases: [toolkit]
defined_for: idempotency-key
rules_hash: 6dc459d3a1d1
---
# Platform toolkit
## Definition
The platform toolkit is capability S54. It holds the shared backend building blocks that other capabilities use, so they don't each build their own. It covers [problem+json ↗](../sw-external-terms.md#problem-json) errors, per-request data and transactions, checks that report whether a service is alive and ready, [graceful shutdown ↗](../sw-external-terms.md#graceful-shutdown), turning away excess requests under heavy load, and outbound HTTP calls that cope with failures. For idempotency, it provides the [`@Idempotent`](idempotent-decorator.md) route declaration and a scheduled task that removes old [idempotency keys](idempotency-key.md); putting these in one shared place keeps behaviour the same across services, which is design intent (not stated in the spec).

## Example
A route such as [`POST /checkout`](post-checkout.md) is declared with `@Idempotent`. A request to it without an [`Idempotency-Key` header](idempotency-key.md) is rejected with [`422 idempotency_key_required`](idempotency-key.md). The link between this route and `@Idempotent` is inferred from S10, not stated by S54.

## Known gaps
- The spec does not say which routes carry `@Idempotent`. Rules C-01 and C-07 are inferred only from the S10, S13 and S50 lines.
- The spec does not say where the toolkit stores idempotency keys or how long they live.
- The spec does not say how a toolkit-declared route answers a repeated key that comes with a different request body.

## Used by
<!-- used-by:start -->
- [backend-api](backend-api.md)
- [bootstrap-app](bootstrap-app.md)
- [crash-handlers](crash-handlers.md)
- [csp-reports-controller](csp-reports-controller.md)
- [health-probes](health-probes.md)
- [idempotency-key](idempotency-key.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [idempotent-decorator](idempotent-decorator.md)
- [load-shedding](load-shedding.md)
- [post-csp-reports](post-csp-reports.md)
- [programmer-error](programmer-error.md)
- [request-context](request-context.md)
- [resilient-http](resilient-http.md)
- [safe-http-client](safe-http-client.md)
- [transaction-runner](transaction-runner.md)
- [unsupported-media-type](unsupported-media-type.md)
- [write-behind-counter](write-behind-counter.md)
<!-- used-by:end -->
