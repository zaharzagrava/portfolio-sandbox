---
id: csp-reports-controller
title: CspReportsController
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# CspReportsController
## Definition
`CspReportsController` is the backend controller that implements [`POST /api/csp-reports`](post-csp-reports.md). Its code is in the [platform toolkit](platform-toolkit.md), but the route belongs to the [app shell capability (W07)](../capabilities/W07-app-shell.md). It receives browser reports of content that the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) blocked. It logs the [violated directive ↗](../sw-external-terms.md#csp-directive) and the blocked host. It gives the same empty success answer for any body or content type. Design intent (not stated in the spec): a fixed answer tells a sender nothing about how its input was handled, and browsers ignore the answer anyway.

## Example
Code: `packages/backend/libs/infrastructure/platform/csp-reports.controller.ts#CspReportsController`. A browser blocks an image from an unlisted host and posts a report. The controller logs the directive and the blocked host, then answers:
```
HTTP/1.1 204 No Content
```
The body type the browser sends (for example `application/reports+json`) is illustrative and does not change the answer.

## Known gaps
- Not confirmed in the code: where the `/api` prefix comes from. The controller does not show it, and only a code comment gives the full path.
- The spec does not say which report formats the controller parses when it pulls out the directive and blocked host.
- The spec does not say whether the controller's route has a rate limit or a body size limit.

## Used by
<!-- used-by:start -->
- [platform-toolkit](platform-toolkit.md)
<!-- used-by:end -->
