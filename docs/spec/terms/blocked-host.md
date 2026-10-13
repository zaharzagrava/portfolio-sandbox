---
id: blocked-host
title: Blocked host
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e8992170c2c3
---
# Blocked host
## Definition
The blocked host is the host of a resource that the browser refused to load because the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) did not allow it. When the browser sends its [violation report ↗](../sw-external-terms.md#csp-violation-report) to [`POST /api/csp-reports`](post-csp-reports.md), the endpoint logs the blocked host with the [violated directive ↗](../sw-external-terms.md#csp-directive). The endpoint always answers with an empty success response, whatever the body or content type. [Operators](operator.md) use these log lines to find content the policy is blocking.

## Example
A page tries to load an image from `images.other-site.example`, a host that is not allowed (illustrative). The browser blocks it and sends a report. The endpoint logs the directive (for example `img-src`) and the host `images.other-site.example`, then answers `204`.

## Known gaps
- The spec does not say whether only the host is logged or the full blocked URL. It also does not say how a report with no blocked URL (for example an inline script) is logged.
- The spec does not say whether `POST /api/csp-reports` has a [rate limit](rate-limit.md) or a body size limit. It is a public endpoint that accepts any body.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): B-14
- [operator](operator.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
