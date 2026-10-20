---
id: board-not-found
title: board_not_found (404)
kind: term
status: draft
aliases: [board_not_found]
defined_for: J05-engagement-loop
rules_hash: e3b0c44298fc
---
# board_not_found (404)
## Definition
`board_not_found` is the 404 error code returned when a post targets a product the system does not know. The request is refused before anything is written, so no `discussion.*` event is emitted and no feed changes. It is how the Discussion capability enforces that a board exists only for a known product.

## Example
```
POST (create post on the board of an unknown product)
→ 404, problem body with code "board_not_found"   (body shape illustrative)
```

## Known gaps
- The spec does not give the route or the exact problem body for this answer.
- The spec does not say whether comments on an unknown product's board return the same code.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
