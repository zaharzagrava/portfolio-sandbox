# Streams, Buffers, Backpressure

Streams let you process data in **constant memory**. Backpressure is how a slow consumer tells a fast producer to slow down. In most "my Node service OOMs when exporting reports" stories, the root cause is missing backpressure.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OrderExportService`](../../packages/backend/libs/domains/orders/application/order-export.service.ts#L28): OrderExportService streams the orders-to-CSV export to S3 with backpressure, so memory stays constant. _(order-export.service.ts)_
> - [`streamStatementCsv`](../../packages/backend/libs/domains/statements/infra/statement-export.ts#L34): streamStatementCsv streams statements from a Postgres cursor to a Writable with backpressure. _(statement-export.ts)_
<!-- theory-links:end -->

---

## 1. Stream types

| Type | Example | Key methods/events |
|---|---|---|
| Readable | `fs.createReadStream`, HTTP request (server side), DB cursor | `read()`, `'data'`, `'end'`, async iteration |
| Writable | `fs.createWriteStream`, HTTP response, S3 upload | `write()` → boolean, `'drain'`, `end()` |
| Duplex | TCP socket | both, independent |
| Transform | gzip, CSV parser, JSON→CSV | `_transform(chunk, enc, cb)` |

- **Object mode** streams pass JS objects instead of bytes. Their `highWaterMark` counts **objects** (default 16) rather than bytes (byte streams default to 64 KiB since Node 22; it was 16 KiB before, except fs read streams, which were already 64 KiB).

---

## 2. Backpressure mechanics

```
producer ──write(chunk)──► [ internal buffer ]──► consumer (slow)
                    ▲              │
                    │   buffer > highWaterMark → write() returns false
                    └──── wait for 'drain' ◄────┘
```

- `writable.write()` returns `false` once the internal buffer passes `highWaterMark`. The producer **must stop** and wait for `'drain'`.
- If you ignore the return value, data piles up in memory and you get an OOM.
- `pipe()` and `pipeline()` handle this automatically.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`streamStatementCsv`](../../packages/backend/libs/domains/statements/infra/statement-export.ts#L34): streamStatementCsv writes cursor rows to a Writable and respects backpressure instead of buffering the whole result. _(statement-export.ts)_
> - [`OrderExportService`](../../packages/backend/libs/domains/orders/application/order-export.service.ts#L28): OrderExportService streams CSV to S3 with backpressure. _(order-export.service.ts)_
<!-- theory-links:end -->

### Manual handling (understand it, rarely write it)
```ts
import { once } from 'node:events';
for (const row of rows) {
  if (!out.write(serialize(row))) await once(out, 'drain');
}
out.end();
```

---

## 3. Use `pipeline`, not `pipe`

`a.pipe(b)` **doesn't forward errors** and doesn't destroy the other streams on failure, which leaks file descriptors and sockets. Use `stream/promises`:

```ts
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

await pipeline(
  fs.createReadStream('in.csv'),
  csvParse({ columns: true }),
  async function* (rows) {                       // async generator as a transform
    for await (const row of rows) {
      if (row.amount > 0) yield JSON.stringify(row) + '\n';
    }
  },
  createGzip(),
  fs.createWriteStream('out.ndjson.gz'),
  { signal: AbortSignal.timeout(60_000) },        // cancellation
);
```

---

## 4. Real-world patterns

### 4.1 Streaming a big export from Postgres to the client
```ts
import QueryStream from 'pg-query-stream';

app.get('/export.csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const qs = new QueryStream('SELECT * FROM invoices WHERE period = $1', [req.query.period], { batchSize: 1000 });
    res.setHeader('Content-Type', 'text/csv');
    await pipeline(client.query(qs), toCsvTransform(), res);  // backpressure all the way to the browser
  } finally {
    client.release();
  }
});
```
- Memory stays flat no matter how big the result is, because the server-side cursor fetches `batchSize` rows at a time.
- **Trade-off:** it holds a DB connection (and a snapshot) for the whole download. For very large exports, generate the file **asynchronously** to S3 and return a presigned URL (async request-reply).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`streamStatementCsv`](../../packages/backend/libs/domains/statements/infra/statement-export.ts#L34): streamStatementCsv streams shop statements from a Postgres cursor to the output Writable in batches, keeping memory flat. _(statement-export.ts)_
> - [`csvCell`](../../packages/backend/libs/domains/statements/infra/statement-export.ts#L10): csvCell quotes, escapes and neutralizes formula injection for each CSV cell in the streamed export. _(statement-export.ts)_
> - [`OrderExportService`](../../packages/backend/libs/domains/orders/application/order-export.service.ts#L28): OrderExportService queues exports and streams the result to S3 asynchronously, which is the async-export alternative for large downloads. _(order-export.service.ts)_
<!-- theory-links:end -->

### 4.2 Upload directly to S3 without buffering
```ts
import { Upload } from '@aws-sdk/lib-storage';
await new Upload({ client: s3, params: { Bucket, Key, Body: req } }).done(); // multipart, streamed
```
Better still: the client uploads straight to S3 with a **presigned URL** or presigned POST, so the bytes never pass through your service.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`S3ObjectStorage`](../../packages/backend/libs/infrastructure/storage/s3-object-storage.ts#L21): S3ObjectStorage supports presigned POST and multipart uploads, so clients can upload directly to S3. _(s3-object-storage.ts)_
> - [`PresignedPost`](../../packages/backend/libs/infrastructure/storage/object-storage.port.ts#L3): PresignedPost holds the url, fields and key that let the client upload straight to S3. _(object-storage.port.ts)_
<!-- theory-links:end -->

### 4.3 Processing a big JSON file
`JSON.parse` on 500 MB blocks the loop and needs several times that in memory. Use a streaming parser (`stream-json`) or switch the format to NDJSON.

---

## 5. Buffers

- A `Buffer` is a `Uint8Array` subclass allocated **outside the V8 heap**. It shows up as `external`/`arrayBuffers` in `process.memoryUsage()`, not in `heapUsed`. That's why "the heap looks fine but RSS keeps growing" can point to a buffer problem.
- `Buffer.alloc(n)` is zero-filled. `Buffer.allocUnsafe(n)` is faster but may contain **old memory** (sensitive data), so overwrite it completely before use.
- Small buffers come out of a shared 8 KiB pool. Slicing (`buf.subarray`) **shares memory**: holding a tiny slice keeps the whole parent alive, which can leak.
- String ↔ Buffer conversions need an explicit encoding (`utf8`, `base64`, `hex`). Watch out for multibyte characters split across chunks; use `StringDecoder` or `setEncoding('utf8')`.

---

## 6. Web Streams vs Node Streams

Node also implements WHATWG `ReadableStream`/`WritableStream` (used by `fetch`). Convert with `Readable.fromWeb()` / `Readable.toWeb()`. Next.js route handlers and edge runtimes use Web Streams.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`streamSse`](../../packages/web/lib/api/sse-reader.ts#L46): streamSse uses fetch streaming on the web client and parses the response body as a web stream. _(sse-reader.ts)_
> - [`AssistantStreamer`](../../packages/backend/libs/domains/assistant/api/assistant-stream.ts#L16): AssistantStreamer pipes provider generation events to SSE responses. _(assistant-stream.ts)_
<!-- theory-links:end -->

---

## 7. Server-Sent Events / streaming responses (LLM-style)

```ts
app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const timer = setInterval(() => res.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`), 1000);
  req.on('close', () => clearInterval(timer));   // client disconnect → cleanup (common leak)
});
```

Watch out for proxies that buffer the response (nginx `X-Accel-Buffering: no`), compression middleware, and LB idle timeouts. Send heartbeats.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopicStreamController`](../../packages/backend/apps/sse-gateway/src/topic-stream/topic-stream.controller.ts#L31): TopicStreamController serves SSE streams for multiple real-time topics over one connection. _(topic-stream.controller.ts)_
> - [`LiveStreamController`](../../packages/backend/apps/sse-gateway/src/live/live-stream.controller.ts#L20): LiveStreamController serves SSE streams of live comments with a snapshot and batched updates. _(live-stream.controller.ts)_
> - [`AssistantStreamer`](../../packages/backend/libs/domains/assistant/api/assistant-stream.ts#L16): AssistantStreamer pipes LLM generation events to SSE responses with gap-free replay. _(assistant-stream.ts)_
<!-- theory-links:end -->

---

## 8. Custom Stream Implementations

Sometimes you need to implement your own stream logic (e.g., in custom parsers or coding challenges):

- **Custom `Readable`**: Instantiate `new Readable({ read(size) { ... } })`. You must provide a `read` method, even if it's a no-op (e.g. if you are pushing data manually from an external event source). Calling `this.push(chunk)` adds data to the internal buffer. Calling `this.push(null)` signals the end of the stream (EOF).
- **Custom `Transform`**: Instantiate `new Transform({ transform(chunk, encoding, callback) { ... } })`. Inside the `transform` function:
  - Modify the `chunk`.
  - Use `this.push(modifiedChunk)` to pass data down the pipeline.
  - Omit `this.push()` to **filter/drop** the chunk entirely.
  - Always call `callback(err)` when done processing the current chunk. 

**Flowing Mode Mechanics**: 
A `Readable` stream starts in **paused mode**. It switches to **flowing mode** (where data is emitted automatically as fast as possible) when you:
1. Call `.pipe()`.
2. Attach a `'data'` event listener.
3. Call `.resume()`.
*Note: You can attach a `'data'` listener to intercept or log chunks without breaking a `.pipe()` setup; both the listener and the pipe destination will receive the chunks.*

---

## Interview Q&A

**Q: What is backpressure, and what happens without it?**
It's a flow-control signal from consumer to producer. In Node, `write()` returns false once the buffer exceeds `highWaterMark`, and you wait for `'drain'`. Without it, a fast producer (a DB cursor) feeding a slow consumer (a mobile client) buffers everything in memory and the process runs out of memory.

**Q: Why `pipeline` over `pipe`?**
`pipeline` propagates errors, destroys all streams on failure (no fd or socket leaks), supports async generators as transforms, and accepts an `AbortSignal`.

**Q: How would you generate a 2 GB CSV report?**
Stream from a DB cursor through a CSV transform into gzip and then to S3 multipart upload, all in an async job. Notify the user with a presigned download URL. Memory use stays constant and no HTTP request has to stay open for minutes.

**Q: What triggers a Node.js `Readable` stream to switch into "flowing" mode, and how do you filter chunks dynamically?**
You switch a stream into flowing mode by attaching a `'data'` event listener, calling `.resume()`, or calling `.pipe()`. To filter chunks dynamically, you route the stream through a `Transform` stream and omit the `this.push(chunk)` call inside the `_transform` callback for any chunks you want to drop. You can also attach a `'data'` listener purely for intercepting or logging chunks without breaking an existing `.pipe()`!
