---
id: load-shedding
title: Load shedding
kind: term
status: draft
aliases: []
defined_for: idempotency-key
rules_hash: da137f559a1f
---
# Load shedding
## Definition
Load shedding means a service rejects some incoming work early when it is overloaded. This protects the service, so it can keep answering the requests it accepts. The [platform toolkit](platform-toolkit.md) provides load shedding as a shared building block for backend services. Sharing it means every service behaves the same way under overload. That reason is design intent (not stated in the spec).

## Example
Illustrative only: a service is overloaded and receives more requests than it can handle. The toolkit's load shedding rejects the extra requests right away, without queueing them. The service keeps serving the requests it already accepted. The spec gives no status code, threshold or route for this.

## Known gaps
- The spec does not say what triggers load shedding, for example in-flight requests, latency or queue length.
- The spec does not say how a shed request is answered, for example its status code or [problem+json ↗](../sw-external-terms.md#problem-json) body.
- The spec does not say how load shedding relates to the [rate limit](rate-limit.md) or the [upstream in-flight limit](upstream-in-flight-limit.md).

## Used by
<!-- used-by:start -->
- [bounded-concurrency](bounded-concurrency.md)
- [cache-loader-busy](cache-loader-busy.md)
- [configure-http-app](configure-http-app.md)
- [http-pipeline](http-pipeline.md)
- [in-flight-request](in-flight-request.md)
- [platform-toolkit](platform-toolkit.md)
- [rate-limit](rate-limit.md)
- [upstream-in-flight-limit](upstream-in-flight-limit.md)
<!-- used-by:end -->
