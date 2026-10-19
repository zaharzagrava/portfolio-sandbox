---
id: import-progress-event
title: Import progress event
kind: term
status: draft
aliases: [progress events]
defined_for: J04-catalog-sync-to-search
rules_hash: 9218b6f3535a
---
# Import progress event
## Definition
A progress event is a frame a catalog import sends on its [SSE stream ↗](../sw-external-terms.md#server-sent-events) while it is still running. The import is processed asynchronously from the catalog-imports queue, and progress events let the client follow it live. They come before the terminal event, which closes the stream with the import's end state. A client watching progress events does not need to poll the import's status.

## Example
The owner of shop `SH` starts an import of catalog file `F1` (60 rows) and opens the import's SSE stream. Progress events arrive while the rows are processed. Then the terminal event arrives, and the products appear in public search.

## Known gaps
- The spec does not say what the progress event type is called, or what its data line contains (for example, rows processed so far or the import row counts).
- The spec does not say how often progress events are sent, or whether a rejected file such as `F3` sends any before the `failed` terminal event.
- The spec does not say whether a client that reconnects can get missed progress events again. FR-016 covers only the terminal event, and no scenario names it.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
