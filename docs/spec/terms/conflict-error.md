---
id: conflict-error
title: conflict error (409)
kind: term
status: draft
aliases: [conflict]
defined_for: problem-json-errors
rules_hash: ddac55bbd8f3
---
# conflict error (409)
## Definition
`conflict` is the [error code](error-code.md) returned with status `409` when a database [unique constraint ↗](../sw-external-terms.md#unique-violation) is violated. The body uses [generic text](error-catalogue.md) only. It never names the column, the constraint or the conflicting value. The design intent (not stated in the spec) is to avoid leaking the schema and to avoid revealing which values already exist.

## Example
Two concurrent requests try to insert the same unique value. The second one receives the following (values are illustrative):
```json
{ "status": 409, "code": "conflict", "detail": "<generic catalogue text>", "[requestId](request-id.md)": "0192f0c1-..." }
```

## Known gaps
- The spec does not say whether a [capability](section.md) may raise its own, more specific `409` code instead of the generic `conflict`.
- The spec does not say whether other database errors, such as foreign-key violations, also map to `conflict`.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-02
- [already-member](already-member.md)
- [already-verified](already-verified.md)
- [document-already-approved](document-already-approved.md)
- [document-superseded](document-superseded.md)
- [error-catalogue](error-catalogue.md)
- [error-code](error-code.md)
- [last-owner](last-owner.md)
- [mfa-not-enabled](mfa-not-enabled.md)
- [no-previous-index](no-previous-index.md)
- [order-not-cancellable](order-not-cancellable.md)
- [reindex-in-progress](reindex-in-progress.md)
- [resubmission-required](resubmission-required.md)
- [section](section.md)
- [shop-limit-reached](shop-limit-reached.md)
- [slug-taken](slug-taken.md)
- [submission-required](submission-required.md)
- [task-already-resolved](task-already-resolved.md)
- [version-conflict](version-conflict.md)
<!-- used-by:end -->
