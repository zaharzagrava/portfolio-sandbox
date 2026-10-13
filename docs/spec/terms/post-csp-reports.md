---
id: post-csp-reports
title: POST /api/csp-reports
kind: term
status: draft
aliases: [/api/csp-reports]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# POST /api/csp-reports
## Definition
`POST /api/csp-reports` is the endpoint that receives a browser's report when the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) blocks some content. It logs the violated [directive ↗](../sw-external-terms.md#csp-directive) and the blocked host. It always answers `204`, whatever the body or content type. [`CspReportsController`](csp-reports-controller.md) in the [platform toolkit](platform-toolkit.md) implements it. The `/api` prefix is not visible in the controller; only a code comment names the full path. Design intent (not stated in the spec): browsers ignore the answer, and a fixed `204` tells a sender nothing about how its input was handled.

## Example
A browser blocks a script from an unlisted host and sends a report. The endpoint logs the directive and the blocked host, then answers:
```
HTTP/1.1 204 No Content
```

## Known gaps
- The spec does not say that the [`Reporting-Endpoints` ↗](../sw-external-terms.md#reporting-endpoints) header points to this path, although both belong to the same policy.
- The spec does not say whether this endpoint is [rate limited](rate-limit.md) or has a [body size limit](graphql-body-size-limit.md).
- The spec does not say which report formats are parsed when the endpoint logs a report.

## Used by
<!-- used-by:start -->
- [graphql-body-size-limit](graphql-body-size-limit.md)
- [platform-toolkit](platform-toolkit.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
