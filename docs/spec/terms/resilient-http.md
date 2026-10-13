---
id: resilient-http
title: Resilient HTTP
kind: term
status: draft
aliases: []
defined_for: idempotency-key
rules_hash: fe8c04a6ff6f
---
# Resilient HTTP
## Definition
Resilient HTTP is the [platform toolkit](platform-toolkit.md)'s shared way for a service to call other services over HTTP. A resilient client usually adds timeouts, retries and [circuit breaking ↗](../sw-external-terms.md#circuit-breaker), so that a slow or failing [upstream](upstream.md) does less damage (general engineering knowledge). The toolkit provides it so each capability does not write its own HTTP client logic. That reason is design intent (not stated in the spec).

## Example
Illustrative only: a service calls an upstream through the toolkit's HTTP client. The upstream times out, so the client fails the call quickly instead of hanging. [S13](../capabilities/S13-payment-intents.md) lists a "PSP circuit breaker", but the spec does not say that it is built on the toolkit's resilient HTTP.

## Known gaps
- The spec does not say which mechanisms resilient HTTP includes, such as timeouts, retries, backoff or circuit breakers, or what their settings are.
- The spec does not say whether resilient HTTP retries [non-idempotent ↗](../sw-external-terms.md#idempotency) calls, or whether it sends an [`Idempotency-Key`](idempotency-key.md) on retry.
- The spec does not say which capabilities use it.

## Used by
<!-- used-by:start -->
- [platform-toolkit](platform-toolkit.md)
- [request-id](request-id.md)
- [safe-http-client](safe-http-client.md)
- [upstream](upstream.md)
<!-- used-by:end -->
