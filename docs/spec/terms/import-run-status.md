---
id: import-run-status
title: Import run status
kind: term
status: draft
aliases: [failed]
defined_for: J04-catalog-sync-to-search
rules_hash: e3b0c44298fc
---
# Import run status
## Definition
The import run status is the state of one bulk catalog import for a shop. The import runs asynchronously from the [`catalog-imports` queue](catalog-imports-queue.md), and its progress and terminal event stream over [SSE ↗](../sw-external-terms.md#server-sent-events). `FAILED` is the end state of an import that was rejected. When an import fails, the reason is in [`failure.code`](failure-code.md), the [terminal SSE event](terminal-event.md) is `failed`, and no product count or search total changes.

## Example
File `F3` is a ZIP renamed `.csv`. The import of `F3` ends `FAILED` with `failure.code: unsupported_file_type`, and the SSE stream ends with the event `failed`.

## Known gaps
- The spec does not say which other statuses exist, or the full lifecycle of an import; only `FAILED` is named.
- The spec does not say whether the terminal SSE event can be replayed to a client that reconnects late (FR-016 has no scenario).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
