---
id: create-event-stream
title: createEventStream
kind: term
status: draft
aliases: [createeventstream wrapper]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# createEventStream
## Definition
`createEventStream` is the web client's wrapper around the browser's [`EventSource` ↗](../sw-external-terms.md#event-source). It lives in the web package and is how front-end code opens a [stream connection](stream-connection.md) to the [realtime hub](realtime-hub.md). It calls `GET /api/streams` with the requested topics and passes received [stream frames](stream-frame.md) to the calling code. The browser's `EventSource` reconnects on its own and sends back the last `id:` it saw as [`Last-Event-ID` ↗](../sw-external-terms.md#last-event-id), so event replay continues from the [replay cursor](replay-cursor.md).

## Example
Hypothetical use on a page that follows one shop's topics. The signature, option names and topic name are illustrative and not confirmed:
```ts
const stream = createEventStream({ topics: ["user:<A>"] });
// opens GET /api/streams?topics=user:<A>
```
If the connection drops, the browser waits for the `retry:` delay the hub sent, then reconnects with `Last-Event-ID: <cursor>`.

## Known gaps
- The spec does not say what `createEventStream` accepts or returns, or how callers register handlers for event types.
- The spec does not say whether the wrapper handles `resync`, `revoked` or baseline frames itself, for example by reloading REST state after a `resync`, or leaves them to the caller.
- The spec does not say how the wrapper reacts to a refusal (`401`, `403`, `429`, `503`). The browser's `EventSource` does not expose the problem+json body or `Retry-After`, so the wrapper may stop or keep retrying without telling the caller.

## Used by
<!-- used-by:start -->
- [realtime-hub](realtime-hub.md)
- [replay-cursor](replay-cursor.md)
- [stream-connection](stream-connection.md)
- [stream-frame](stream-frame.md)
<!-- used-by:end -->
