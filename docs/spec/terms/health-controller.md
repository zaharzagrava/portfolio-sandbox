---
id: health-controller
title: HealthController
kind: term
status: draft
aliases: []
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# HealthController
## Definition
`HealthController` is the controller that serves the [health probes](health-probes.md) on an app's own HTTP server. It answers `GET` and `HEAD` on `/health/live`, `/health/ready` and `/health/startup`. [Liveness](health-probes.md) uses only in-process state and never touches a store. [Readiness](readiness.md) fails only while starting, while shutting down or when a [critical pod-local check](health-check-criticality.md) fails. Probe bodies list only check names with `up` or `down`. Error text goes to logs and the [`health_check_up` gauge](health-check-up.md).

## Example
The database and cache are both unreachable. Readiness still answers 200 because these checks are [shared checks](health-check-criticality.md) (S54.B-07). The JSON shape below is illustrative:
```
GET /health/ready
200
{ "database": "down", "cache": "down" }
```

## Known gaps
- The spec does not say the exact JSON shape of a probe body. It says only that the body holds check names and `up` or `down`.
- The spec does not say which status codes `/health/startup` returns before and after warm-up, or which status a failing `/health/live` returns.
- Not confirmed in the code: whether `HealthController` and the management listener share one implementation of the checks.

## Used by
<!-- used-by:start -->
- [health-check-criticality](health-check-criticality.md)
- [health-check-up](health-check-up.md)
- [health-probes](health-probes.md)
- [readiness](readiness.md)
<!-- used-by:end -->
