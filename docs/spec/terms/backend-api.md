---
id: backend-api
title: Backend API
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: 9d910bb53b6b
---
# Backend API
## Definition
The backend API is the server-side part of the system. Its code is under `packages/backend`, separate from the web app in `packages/web`. The web app shell uses it for one endpoint, [`POST /api/csp-reports`](post-csp-reports.md). That endpoint receives the reports browsers send when they block content. [`CspReportsController`](csp-reports-controller.md) in the [platform toolkit](platform-toolkit.md) implements it.

## Example
A browser blocks a script that the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) does not allow. It sends a report to `POST /api/csp-reports`. `CspReportsController` (`packages/backend/libs/infrastructure/platform/csp-reports.controller.ts`) logs the directive and the blocked host and answers `204`.

## Known gaps
- The spec does not say whether backend API responses also carry the [static security headers](static-security-headers.md), or only web app responses do.
- The spec does not say which configuration value holds the backend API's address. The [validated config module](validated-config-module.md) lists `API_URL`, `BFF_URL` and `SSE_URL`, but the facts do not say what each one points to.
- Not confirmed in the code: the `/api` prefix of `/api/csp-reports` does not appear in the controller. Only a comment names the full path.

## Used by
<!-- used-by:start -->
- [barrel-export](barrel-export.md)
- [platform-toolkit](platform-toolkit.md)
- [static-security-headers](static-security-headers.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->
