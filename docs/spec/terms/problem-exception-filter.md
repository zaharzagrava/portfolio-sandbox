---
id: problem-exception-filter
title: Problem exception filter
kind: term
status: draft
aliases: [exception filter, filter]
defined_for: problem-json-errors
rules_hash: 746658b210a2
---
# Problem exception filter
## Definition
The problem exception filter is the service's [global exception filter ↗](../sw-external-terms.md#nestjs-exception-filter). It turns every error thrown in a request into one [problem+json ↗](../sw-external-terms.md#problem-json) response. It must never write to a response whose headers were already sent, and it must never throw. If rendering the problem itself fails, it falls back to a minimal [`500 internal_error`](internal-error.md).

## Example
A handler throws an exception that wraps an SQL error. The filter renders a `500` problem body that contains the [fixed catalogue `detail`](error-catalogue.md) and the [`requestId`](request-id.md). The SQL text and the stack trace never reach the client.

## Known gaps
- The spec does not say what the filter does when an error happens after headers are already sent. It only says the filter must not write.
- The spec does not say which members the "minimal" fallback body contains.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-09
- [problem-json-errors](../concepts/problem-json-errors.md): C-07
- [configure-http-app](configure-http-app.md)
- [error-catalogue](error-catalogue.md)
- [exact-body-members](exact-body-members.md)
- [http-pipeline](http-pipeline.md)
- [internal-error](internal-error.md)
- [invalid-rate-limit-cost-error](invalid-rate-limit-cost-error.md)
- [programmer-error](programmer-error.md)
- [unsupported-media-type](unsupported-media-type.md)
<!-- used-by:end -->
