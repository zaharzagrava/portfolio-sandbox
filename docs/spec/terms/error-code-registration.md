---
id: error-code-registration
title: Error code registration
kind: term
status: draft
aliases: [owners, registration]
defined_for: problem-json-errors
rules_hash: 1b3f092b8dd4
---
# Error code registration
## Definition
An error code registration declares a stable [`code`](error-code.md) together with its definition and the owner that registered it. Codes come from different [capabilities](section.md), and all of them share one [namespace](error-code.md). If the same `code` is registered twice with different definitions, startup fails, and the error message names both owners. The design intent (not stated in the spec) is to catch code collisions at deploy time, so that clients never receive one `code` with two meanings.

## Example
S01 registers `invalid_token` with one definition. A second module registers `invalid_token` with a different status. The service refuses to start and names both owners in the error. (This scenario is illustrative.)

## Known gaps
- The spec does not say which fields make up a "definition". It might be status, title or [catalogue text](error-catalogue.md).
- The spec does not say whether two registrations with an identical definition are allowed. The rule only forbids *different* definitions.
- The spec does not give a full list of registered codes.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-07
- [problem-json-errors](../concepts/problem-json-errors.md): C-06
- [error-catalogue](error-catalogue.md)
- [error-code](error-code.md)
- [section](section.md)
<!-- used-by:end -->
