---
id: terminal-event
title: Terminal event
kind: term
status: draft
aliases: [terminal]
defined_for: J04-catalog-sync-to-search
rules_hash: 7af00249eb80
---
# Terminal event
## Definition
The terminal event is the last event a catalog import sends on its [SSE stream ↗](../sw-external-terms.md#server-sent-events), after the [progress events](import-progress-event.md). It tells the client that the import has reached its end state. The only terminal event the facts name is `failed`, sent when the import ends `FAILED`. A client can watch for this event instead of [polling ↗](../sw-external-terms.md#polling) the import's status.

## Example
File `F3` is a ZIP renamed `.csv`. Its import ends `FAILED` with `failure.code: unsupported_file_type`, and the stream closes with this [event type line](sse-event-type-line.md):
```
event: failed
```

## Known gaps
- The spec does not say what the terminal event is called for an import that succeeds; only `failed` is named.
- The spec does not say what the terminal event's data line contains, for example whether it carries `failure.code` or the row counts.
- The spec does not say whether a client that reconnects late can get the terminal event again (FR-016 has no scenario).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
