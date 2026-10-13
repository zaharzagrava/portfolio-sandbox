---
id: invalid-transition
title: invalid_transition
kind: term
status: draft
aliases: []
defined_for: search-index
rules_hash: e3b0c44298fc
---
# invalid_transition
## Definition
`invalid_transition` is an error code linked to the reindex run state machine of the product search index. The facts name only the code and say nothing about its behaviour. Design intent (not stated in the spec): a request gets it when it asks a reindex run to move to a state it cannot reach from its current state. It is a different code from reindex_in_progress, which refuses a second start or rollback while a run is active.

## Example
An operator sends a reindex request that the run's current state does not allow (illustrative). The error answer carries this code:
```json
{ "code": "invalid_transition" }
```
The HTTP status and the other body members are not stated in the facts, so they are left out here.

## Known gaps
- The spec does not say which reindex run states exist, or which transitions are allowed between them.
- The spec does not say which HTTP status `invalid_transition` uses, or which endpoints can return it.
- The spec does not say how a request that is refused with `invalid_transition` differs from one refused with `409 reindex_in_progress`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
