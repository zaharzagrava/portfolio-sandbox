# SSE (Server-Sent Events): how it works, and the web client checklist

## Is SSE a browser standard?

Yes. It's part of the **HTML Living Standard** (WHATWG), under "Server-sent events". Every modern browser has it built in (Chrome, Firefox, Safari, Edge) through the **`EventSource`** API, so no library is needed.

How it works:

1. The browser does a normal `GET` with `Accept: text/event-stream`.
2. The server answers `200` with `Content-Type: text/event-stream` and **never closes the response**. It keeps writing small text blocks:
   ```
   retry: 3000

   id: 1730-0
   event: price
   data: {"topic":"auction:abc","data":{"price":1300}}

   : ping
   ```
   - `data:` is the payload, and a blank line ends one message.
   - `event:` is the message name (which listener fires).
   - `id:` is the position in the stream.
   - `retry:` tells the browser how long to wait before reconnecting.
   - A line starting with `:` is a comment. Our server sends `: ping` every 15 s so proxies don't kill an idle connection.
3. **Reconnect is automatic.** If the connection drops, the browser waits `retry` ms, reconnects by itself, and sends the header `Last-Event-ID: <last id it saw>`. Our `sse-gateway` uses that header to replay exactly what was missed.

Limits of `EventSource` that matter here:
- **GET only**, and **no custom headers**, so you can't send `Authorization: Bearer …`. Only cookies (with `withCredentials`) or the URL can carry auth.
- **Server → browser only.** To send something, the client makes a normal request.

## Which HTTP versions?

SSE is plain HTTP, so it works over all of them. Only the transport underneath changes:

| Version | How the stream is carried | Notes |
|---|---|---|
| HTTP/1.1 | One TCP connection held open; the body is sent in chunks (`Transfer-Encoding: chunked`) | Browsers allow only ~**6 connections per host**. Every open stream uses one, so several tabs × several streams can block normal requests. |
| HTTP/2 | One **stream** inside a shared, multiplexed connection | Removes the 6-connection problem (typically ~100 concurrent streams per connection). Recommended. |
| HTTP/3 (QUIC) | Same as HTTP/2, over UDP | Works the same; better on flaky mobile networks. |
| HTTP/1.0 | Technically possible (body ends when the connection closes) | Irrelevant today. |

In our setup:
- **Browser ↔ Cloudflare:** HTTP/2 or HTTP/3.
- **Cloudflare ↔ ALB:** HTTP/1.1 or HTTP/2.
- **ALB → Node:** HTTP/1.1 (target groups use protocol `HTTP`).

That's fine because each hop is independent. What matters on every hop:
- **Nothing may buffer the response.** The server sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`, and the stream must not be compressed into a buffer.
- **Idle timeouts must be longer than the heartbeat interval.** The ALB idle timeout is 3600 s (O-03). Cloudflare drops connections idle for ~100 s, and the 15 s `: ping` heartbeat keeps the stream from looking idle.

## Problems in the proposed web client against our backend

Checked against how `apps/sse-gateway/src/topic-stream/topic-stream.controller.ts` behaves.

**1. Handlers never fire.** The server sets `event:` to the **message type** (`price`, `notification`, …), not to the topic, and puts the topic inside `data`. So:
- `addEventListener(topic, …)` with `auction:abc` never matches anything.
- `onmessage` only fires for messages *without* an `event:` line, and the server always sends one.

So the client receives nothing.

**2. Replay after a drop is broken, in three ways:**
- `Last-Event-ID` is sent as a **query parameter**, but the server reads the **header**.
- `onerror` calls `close()` and creates a new `EventSource`. That throws away the browser's built-in reconnect, which is the only thing that sends the `Last-Event-ID` header.
- `lastEventId` is never updated from incoming events (`event.lastEventId`), so even a manual reconnect would start from the beginning.

**3. It gives up after 5 retries and then stays silent forever.** A live page (auction, order status) should keep reconnecting with capped backoff, and also reconnect when the device comes back `online`.

**4. Auth.** `withCredentials: true` only sends cookies. Our web client keeps the access token **in memory** (SD-39), so private topics like `user:<id>` would be refused. The fix belongs to whoever owns the API: either the stream accepts an auth cookie, or the client first gets a **short-lived stream ticket** and passes it as `?ticket=…`. Check which one the backend actually supports before coding the client.

**5. The AI assistant stream can't use `EventSource` at all.** It's `POST /api/assistant/conversations/:id/messages`, and `EventSource` only does GET. Use `fetch()` and read `response.body` as a stream, or a small library like `@microsoft/fetch-event-source`, which also lets you send `Authorization` headers. Resume uses `GET /api/assistant/messages/:id/stream`, which needs the `Last-Event-ID` **header**, so again `fetch`, not `EventSource`.

**6. Smaller issues:**
- **URL:** the default `http://localhost:3000` is the Next.js app. In dev, `sse-gateway` runs on its own port; in prod, it's `/api/streams` on the API host.
- **One connection per tab:** the server multiplexes several topics in one connection (`?topics=a,b`), so open **one** stream per tab and route by `data.topic`. Over HTTP/1.1 a browser allows only about 6 connections per host, and several tabs each with several streams will hit that.

## The corrected shape (sketch)

```ts
export function createEventStream(topics: string[], types: string[], onEvent: (topic: string, type: string, data: unknown) => void) {
  const url = `${process.env.NEXT_PUBLIC_API_URL}/api/streams?topics=${encodeURIComponent(topics.join(','))}`;
  const es = new EventSource(url, { withCredentials: true });

  // Listen by message TYPE (what the server puts in `event:`); route by the topic inside the payload.
  for (const type of types) {
    es.addEventListener(type, (e) => {
      const { topic, data } = JSON.parse((e as MessageEvent).data);
      onEvent(topic, type, data);
    });
  }

  // Don't close on error: the browser reconnects by itself (server sends `retry: 3000`)
  // and sends Last-Event-ID, so the server replays the gap.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      // Fatal (e.g. 401/403/404 or wrong content type): the browser won't retry.
      // Recreate later with backoff, after refreshing auth if needed.
    }
  };

  return { close: () => es.close() };
}
```

A full reconnect after `CLOSED` starts without history, because a new `EventSource` doesn't send the header. Losing that gap is acceptable for a fatal error, but not for normal network drops, which is why normal drops are left to the browser.
