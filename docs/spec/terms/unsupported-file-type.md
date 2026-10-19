---
id: unsupported-file-type
title: unsupported_file_type
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: e3b0c44298fc
---
# unsupported_file_type
## Definition
`unsupported_file_type` is the [`failure.code`](failure-code.md) set on a [bulk import](catalog-import.md) whose file is not an accepted type. The import ends [`FAILED`](import-run-status.md), sends the [terminal SSE event](terminal-event.md) `failed`, and changes no product or [search total](search-totals.md). A file is judged by its content, so renaming a file does not get it accepted: a ZIP renamed `.csv` is rejected.

## Example
```json
{ "status": "FAILED", "failure": { "code": "unsupported_file_type" } }
```
(Body shape illustrative; [the facts](fact.md) confirm only the status `FAILED` and `failure.code`.)

## Known gaps
- The spec does not say which file types are supported, apart from CSV being the expected format.
- The spec does not say how the real file type is detected.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
