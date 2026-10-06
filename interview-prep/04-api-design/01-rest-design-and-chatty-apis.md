# REST API Design and Minimizing Chatty APIs

> **Covers:** strategies to minimize chatty API calls, including aggregate endpoints.

---

## 1. What "chatty" means and why it hurts

A **chatty API** makes a client issue many fine-grained requests to complete one user action or render one screen:

```
Dashboard load:
GET /me
GET /me/organizations
GET /organizations/7/projects          (→ 12 projects)
GET /projects/1/stats ... GET /projects/12/stats   (12 calls: N+1 over HTTP)
GET /notifications?unread=true
= 16 round trips
```

Costs:
- **Latency**: each round trip on mobile is 50–300 ms of RTT. Sequential dependencies (I need `orgId` before I can ask for projects) **chain** those latencies. HTTP/2 multiplexing removes connection overhead and head-of-line blocking at the HTTP layer, but **can't remove dependency chains**.
- **Server load**: per-request overhead for auth, logging, middleware, connection handling, and repeated DB lookups such as loading the user every time.
- **Failure probability**: with 16 calls at 99.9% each, the chance that all succeed is ~98.4%. Partial failures make UI states complicated.
- **Battery and data usage** on mobile.
- **Rate limits** get exhausted faster.

The opposite failure is a **chunky / over-fetching** API: huge payloads with data nobody uses, poor cacheability, coupling. The goal is the **right granularity for the use case**.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`options`](../../packages/backend/scripts/load-tests/chat.test.js#L37): The k6 chat load test measures HTTP and message round-trip latency thresholds. _(chat.test.js)_
<!-- theory-links:end -->

### 1.1 HTTP/1.1 vs HTTP/2 vs HTTP/3: connections, multiplexing, head-of-line blocking

#### HTTP/1.1: one request at a time per connection, at most 6 connections
- **One exchange per connection at a time.** An HTTP/1.1 response is just `status line + headers + body`. It carries **no request ID**, so the client matches responses to requests **by order** on the connection. While a connection waits for a response, the browser can't send another request on it. Keep-alive only lets the connection be **reused after** the response has arrived. (Pipelining sent requests ahead, but responses still had to return in order, and browsers never enabled it because of buggy proxies.)
- **Why IDs couldn't simply be added to HTTP/1.1:** a TCP connection is one ordered byte stream, and HTTP/1.1 servers and proxies process it **sequentially** (read request → write the *entire* response → read the next). Out-of-order replies need responses **chopped into pieces, interleaved, and labelled with an ID** so they can be reassembled. That framing layer is exactly what HTTP/2 is. Bolting it onto HTTP/1.1 would break the millions of servers, proxies, and middleboxes that read connections sequentially, so it shipped as a **new protocol version** that both sides must agree on (ALPN negotiation in the TLS handshake).
- **6-connection limit.** To get parallelism anyway, browsers open **up to 6 connections per origin** (a per-host limit **shared across all tabs** of that site). That's a browser policy to protect servers and networks. A 7th concurrent request **isn't sent at all**: it waits in the browser's internal queue until a connection frees up.
- **Setup cost per connection:** TCP handshake (1 round trip) + TLS handshake (1–2 round trips) + TCP **slow start** (begins with a small send window and ramps up). On mobile with 150 ms RTT, that's ~300–450 ms before the first byte on each new connection, plus a socket and memory on the server and load balancer.
- Old workarounds born from these limits: domain sharding (`static1.`/`static2.` hosts for more connections), bundling JS/CSS, image sprites.

#### Head-of-line (HOL) blocking
**Definition:** a request that is **ready and cheap** waits for **someone else's** slow response, only because it's stuck in the same line. That's different from normal latency (waiting for your *own* response). Analogy: one checkout lane; you hold a bottle of water, the person ahead has a full cart, and you wait for **their** groceries.

How it happens under HTTP/1.1 (dashboard: 6 slow reports of 2 s + a fast `/me` of 20 ms):
```
t=0ms     6 report requests → browser opens connections #1–#6, one report on each
t=1ms     GET /me → all 6 connections busy (each waiting for its response), no 7th allowed
          → /me waits in the BROWSER'S queue; it has not been sent; the server doesn't know about it
t=2000ms  a report finishes → its connection is free → /me is sent on it
t=2020ms  /me response arrives
Seen by your code: ~2020ms. Server-side duration of /me: 20ms. DevTools Timing: "Stalled ≈ 2000ms"
```
Consequences:
- The page feels as slow as its **slowest** endpoint, even though the server answered everything else in milliseconds. One misbehaving endpoint (slow query, lock wait) degrades **unrelated** features.
- **Invisible in server metrics**: the time is spent queued in the browser before the request is sent.
- **Intermittent**: it only happens when **all** 6 connections are occupied, so it depends on how many slow requests happen to be in flight.

Measured (Node simulation, client limited to 6 connections like Chrome: 6 × 2 s reports, then 10 × 20 ms calls):
```
HTTP/1.1 (6 connections):  fast calls took 2034–2057 ms   ← queued behind the reports
HTTP/2   (1 connection):   fast calls took   25 ms        ← each request is its own stream
```

How to spot it (Chrome DevTools → Network): enable the **Protocol** and **Connection ID** columns (right-click the header). On HTTP/1.1 there are at most 6 connection IDs per origin. In a request's **Timing** tab, a long **"Stalled" / "Queueing"** bar = waiting for a free connection.

#### HTTP/2: multiplexing over one connection
- Every request and response is split into small binary **frames**, each tagged with a **stream ID** (one stream = one request/response). Frames of many streams are **interleaved** on one TCP connection and reassembled by ID. That's **multiplexing**: many requests in flight at once, responses returning **in any order, as soon as each is ready**.
```
HTTP/1.1, one connection:  [ /slow ─────────1s────────── ][ /fast ][ /fast ]   ← fast ones wait
HTTP/2,  one connection:   [ /slow frames ... ......... ]
                           [ /fast ] [ /fast ]                               ← interleaved, done at ~10ms
```
Measured (1 connection; `/slow` = 1 s, `/fast` = 10 ms): HTTP/1.1 → fast requests 1020–1031 ms; HTTP/2 → fast requests 20 ms.

What it gives you:
1. **No HOL blocking at the HTTP layer and no 6-request ceiling.** ~100+ concurrent streams per connection (the server advertises the limit; nginx/Node default 100–128).
2. **One connection per origin**: the TCP + TLS handshake and slow start are paid **once**, and the connection stays warm.
3. **Header compression (HPACK)**, see below.
4. **Long-lived responses don't consume connection slots.** Under HTTP/1.1 each open **SSE** stream (§2.8) or long-poll permanently holds one of the 6 connections. With 6 tabs open, every other request to that origin hangs. Under HTTP/2 it's one more stream. (WebSockets use their own connections either way.)
5. **Fewer sockets** on servers and load balancers.
6. Stream prioritization. (*Server push* existed but browsers removed it; use `103 Early Hints` or `preload` instead.)

#### Header compression (HPACK / QPACK)
Headers are part of each request, but under HTTP/1.1 they're **repeated in full on every request** as **uncompressed text** (bodies can be gzip/brotli compressed; HTTP/1.1 headers never can):
```
GET /api/notifications HTTP/1.1
Host: app.example.com
Cookie: session=eyJhbGciOi...; _ga=GA1.2.1234...; theme=dark; ...      ← often 500 B – 4 KB
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...                          ← JWT, ~0.8–1.5 KB
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ...
Accept: application/json
Accept-Language: en-US,en;q=0.9,uk;q=0.8
```
30 API calls × ~2 KB = **~60 KB uploaded** in identical headers, often more than the request bodies. On mobile, upload is the slow direction, and a big header block can need extra round trips.

HPACK (HTTP/2) and QPACK (HTTP/3): both sides keep a **table of headers already sent on the connection**, so repeats become tiny references:
```
request 1:  full headers → both sides store  62 = "cookie: session=eyJ...",  63 = "authorization: Bearer eyJ..."
request 2:  "62, 63, :path=/api/notifications"   ← a few bytes instead of ~2 KB
```
Plus a static table of common headers and Huffman-coded text. (On the wire, an HTTP/2 request is a HEADERS frame plus optional DATA frames on one stream; logically it's still one request.)

#### Transport per version: TCP vs QUIC (UDP)
| | Transport | Encryption | Multiplexing |
|---|---|---|---|
| HTTP/1.1 | **TCP** | TLS optional (`https` = TLS on top of TCP) | no: one request at a time per connection |
| HTTP/2 | **TCP** | TLS (browsers require it) | yes: streams inside **one TCP connection** |
| HTTP/3 | **QUIC**, which runs on **UDP** | TLS 1.3 **built into** QUIC (mandatory) | yes: streams inside **one QUIC connection** |

- Only **HTTP/3** uses UDP. HTTP/2 kept TCP, which is exactly why it still suffers from TCP-level HOL blocking (one lost packet stalls all streams).
- Why QUIC is built on UDP instead of a "TCP v2": TCP is implemented in OS kernels and inspected by routers, firewalls, and NATs everywhere, so it's practically impossible to change. UDP is just "send this packet". QUIC builds reliability, per-stream ordering, congestion control, and encryption **on top of UDP in user space** (inside the browser and server), so it can evolve without OS or network upgrades.
- Who uses it: **Google built QUIC** (an early Google-only version ran on Google Search and YouTube from ~2013). The IETF standardized it as **QUIC (RFC 9000, 2021)** and **HTTP/3 (RFC 9114, 2022)**. Today Google/YouTube, Meta (Facebook, Instagram), and Cloudflare-fronted sites serve a large share of traffic over h3. It helps most for **video and mobile**: a lost packet only stalls its own stream, resumed connections can skip a handshake round trip, and the connection survives switching from Wi-Fi to 4G.
- Some corporate networks block UDP on port 443. Browsers then silently fall back to h2 over TCP.
- **DevTools "Connection ID"**: Chrome's internal number for the underlying connection (not the QUIC protocol's own connection ID). Many requests sharing one ID **at the same time** = multiplexing (h2 or h3). On HTTP/1.1 you'll also see repeated IDs, but those are *sequential* reuses of a keep-alive connection, one request after another.

#### Checking the HTTP version, and HTTP/2/3 support in NestJS
**From the client side:**
- **Chrome DevTools → Network** → right-click column header → enable **Protocol**: `http/1.1`, `h2`, or `h3` per request. (`h3` often appears only from the 2nd visit, after the browser learns about it.)
- **curl**:
  ```bash
  curl -s -o /dev/null -w '%{http_version}\n' https://api.example.com/health            # prints 1.1 / 2 / 3
  curl -s -o /dev/null -w '%{http_version}\n' --http2 https://api.example.com/health    # ask for h2 explicitly
  curl -sI https://api.example.com | grep -i alt-svc       # alt-svc: h3=":443" → server advertises HTTP/3
  curl --http3 -sI https://api.example.com                 # needs a curl built with HTTP/3 support
  ```
- Browsers use HTTP/2 **only over HTTPS** (negotiated in the TLS handshake via ALPN). Plain `http://` (e.g. `localhost`) is always HTTP/1.1 in the browser. HTTP/3 is discovered through the **`Alt-Svc`** response header, then used on later requests.

**Who actually "speaks" the protocol with the browser:** whatever **terminates TLS** for the public hostname, usually **not your Nest app**:
```
browser ──h2/h3──► Cloudflare / CloudFront / ALB / nginx ingress (TLS here) ──HTTP/1.1──► Nest pods
```
- **Cloudflare / CloudFront**: h2 + h3 to clients by default/toggle.
- **AWS ALB**: h2 to clients (HTTPS listeners); to targets HTTP/1.1 by default (h2 or gRPC optional).
- **ingress-nginx**: h2 enabled by default **on TLS hosts** (`use-http2: true`). HTTP/3 isn't supported in mainline ingress-nginx.
- The hop LB → pods being HTTP/1.1 with keep-alive is normal and fine (in-cluster RTT is sub-millisecond, and the LB keeps a pool of connections).

**NestJS itself:**
- **Default Express adapter (`@nestjs/platform-express`)**: serves **HTTP/1.1 only**. Express doesn't work properly with Node's `http2` module, so don't try to make Express speak h2. Let the proxy do it.
- **Fastify adapter**: native HTTP/2 support (pass the options to the `FastifyAdapter` constructor):
  ```ts
  const app = await NestFactory.create<NestFastifyApplication>(AppModule,
    new FastifyAdapter({ http2: true, https: { key, cert, allowHTTP1: true } }));  // h2 + HTTP/1.1 fallback over TLS
  ```
  This is mainly useful for **gRPC** or end-to-end h2. For a normal API behind a proxy, it's rarely worth it.
- **HTTP/3** in Node: no stable built-in server yet (QUIC support is still experimental). In practice HTTP/3 always comes from the CDN or load balancer.

**Typical setup:** a Nest app created with `NestFactory.create(AppModule)` on `@nestjs/platform-express` speaks HTTP/1.1. If it sits behind an nginx ingress without TLS (`tls: []` in the Helm values), the version browsers see depends on what terminates HTTPS **in front of** the ingress (Cloudflare, a cloud load balancer). If nothing terminates TLS earlier, clients get plain HTTP/1.1. Check with `curl -s -o /dev/null -w '%{http_version}\n' https://api.example.com/` or the Protocol column in DevTools.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`configureHttpApp`](../../packages/backend/libs/infrastructure/platform/bootstrap-http.ts#L12): configureHttpApp sets up the shared Nest HTTP app with security, CORS and validation. _(bootstrap-http.ts)_ · [platform](../../docs/humans/concepts/platform-platform/platform.md)
<!-- theory-links:end -->

#### What HTTP/2 does NOT fix
1. **TCP-level head-of-line blocking.** All streams share one TCP connection, and TCP delivers bytes **strictly in order**. If **one packet is lost**, TCP holds back *everything after it* (for every stream) until the retransmission arrives. On lossy mobile or Wi-Fi networks, HTTP/2 can even do worse than six HTTP/1.1 connections. → **HTTP/3** runs over **QUIC** (on UDP). QUIC gives each stream its own ordering, so a lost packet only delays **its own** stream. It also combines the transport and TLS 1.3 handshakes (1 round trip, 0 for resumed connections) and survives network switches (Wi-Fi → 4G) through connection IDs.
2. **Dependency chains (waterfalls).** If you need `/me` to learn the `orgId` before you can call `/orgs/:id/projects`, the second request **can't start** until the first response arrives. Multiplexing only helps requests that are **independent and in flight at the same time**. Three dependent calls still cost 3 × RTT. That's why aggregate endpoints, a BFF, or server components still matter (§2).
3. **Per-request server cost.** Each request still runs auth, middleware, logging, and DB lookups. Twenty cheap HTTP/2 requests are still twenty units of server work.

**In practice for a Node backend:**
- Browsers only use HTTP/2 over **TLS** (via ALPN negotiation). Usually TLS and HTTP/2 (and HTTP/3) are terminated at the **CDN / load balancer** (Cloudflare, CloudFront, ALB, nginx ingress), and the hop to your Node pods is often HTTP/1.1 with keep-alive. That's fine inside the data center (low RTT, pooled connections).
- Node has `node:http2` built in. `fetch` (undici) can use HTTP/2 for outbound calls when enabled (`allowH2`).
- **gRPC requires HTTP/2**: it uses multiplexed streams for concurrent RPCs and bidirectional streaming.
- With HTTP/2, bundling and domain sharding become less important (sharding actually hurts, because it forces extra connections). Many small requests are cheap at the **connection** level, but not at the latency-chain or server-work level.

---

## 2. Strategy catalog (know the trade-offs of each)

### 2.1 Aggregate (composite) endpoints
A server-side endpoint that composes several resources for one use case:
```
GET /dashboard  →  { me, organizations, projects: [{..., stats}], unreadNotifications: 3 }
```
- ✅ One round trip. The server does the fan-out in its data center (sub-ms latency between services and DB), **in parallel**.
- ✅ The server can optimize: a single SQL query with JOINs, or batched `IN (...)` queries instead of N+1.
- ❌ It couples the API to one screen. If every screen gets its own endpoint, you get endpoint sprawl.
- ❌ Coarser caching: one changed field invalidates the whole aggregate.
- ❌ Tail latency = the slowest component. Mitigate with per-dependency timeouts and **partial responses**:
  ```json
  { "projects": [...], "notifications": null, "errors": [{ "part": "notifications", "code": "UPSTREAM_TIMEOUT" }] }
  ```
- Implementation in Node: `Promise.allSettled` with `AbortSignal.timeout` per dependency. Decide which parts are **required** (fail the whole response) and which are **optional** (degrade).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductPageService`](../../packages/backend/libs/composition/bff/product-page.service.ts#L29): ProductPageService fans out in parallel to core with per-section timeouts and partial errors, composing one aggregate response. _(product-page.service.ts)_
> - [`ProductPage`](../../packages/backend/libs/composition/bff/product-page.service.ts#L11): The ProductPage interface is the aggregate response shape combining product, shop, recommendations, trending, flags and chatUnread. _(product-page.service.ts)_
> - [`BffController`](../../packages/backend/libs/composition/bff/bff.controller.ts#L8): BffController exposes the aggregated product page endpoint to the web frontend. _(bff.controller.ts)_
<!-- theory-links:end -->

### 2.2 Backend-for-Frontend (BFF)
A **dedicated API layer per client type** (web BFF, mobile BFF), owned by the frontend team, that aggregates and reshapes data from domain services.
- ✅ Keeps aggregates out of the core domain services. Each client gets exactly the shape it needs. A natural place for session handling, which also helps security (tokens stay server-side; see the auth doc).
- ❌ One more service to run, with possible logic duplication across BFFs.
- **Next.js server components / route handlers often *are* the BFF**: the server component fetches from internal services and sends only rendered output or minimal data to the browser.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`BffAppModule`](../../packages/backend/apps/bff/src/bff-app.module.ts#L19): BffAppModule is the dedicated stateless Backend-for-Frontend application that sits in front of core. _(bff-app.module.ts)_ · [bff](../../docs/humans/concepts/app-bff/bff.md)
> - [`BffCoreModule`](../../packages/backend/libs/composition/bff/bff.module.ts#L18): BffCoreModule provides the CoreClient the BFF uses to call core domain services. _(bff.module.ts)_
> - [bff](../../docs/humans/concepts/app-bff/bff.md): The bff app configures the stateless BFF NestJS application and its providers.
<!-- theory-links:end -->

### 2.3 Expansion / embedding (`include`/`expand`)
Let the client ask for related resources inline:
```
GET /invoices/123?include=client,lineItems          (JSON:API style)
GET /v1/charges/ch_1?expand[]=customer              (Stripe style)
```
- ✅ One generic API serves different needs without bespoke endpoints.
- ❌ You must cap the depth and breadth (DoS risk), and authorization has to apply to every embedded resource.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ApiResourceType`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L11): ApiResourceType and the versioned public API resources (product, order, list) are what expand and include apply to, though only partially. _(versioning.ts)_
<!-- theory-links:end -->

### 2.4 Sparse fieldsets (field selection)
```
GET /users/42?fields=id,name,avatarUrl
```
Smaller payloads. Combine with expansion. (This is roughly what GraphQL generalizes.)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`pickFields`](../../packages/backend/libs/domains/developer-platform/application/public-catalog.service.ts#L66): pickFields filters response fields according to the JSON:API sparse fieldsets spec to shrink payloads. _(public-catalog.service.ts)_
> - [`ApiProduct`](../../packages/backend/libs/domains/developer-platform/application/public-catalog.service.ts#L11): ApiProduct is the public API response model whose fields can be selected. _(public-catalog.service.ts)_
<!-- theory-links:end -->

### 2.5 Batch / bulk endpoints
```
GET  /projects/stats?ids=1,2,3,...,12           (bulk read)
POST /batch  [{ "method": "GET", "path": "/projects/1/stats" }, ...]   (generic batch, e.g. Microsoft Graph $batch)
POST /line-items:bulkCreate  [ ... 500 items ... ]                     (bulk write)
```
- ✅ Kills the N+1 over HTTP.
- ❌ Generic batch endpoints complicate caching, rate limiting, and auth. Bulk writes need **per-item results** (`207 Multi-Status` style), with clear semantics: atomic all-or-nothing, or best-effort per item.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`BatchBody`](../../packages/backend/libs/domains/developer-platform/api/v1.controller.ts#L44): BatchBody accepts 1-50 batch operations (GET/POST/PATCH on /v1/ paths) in a single request. _(v1.controller.ts)_
> - [`BulkStockBody`](../../packages/backend/libs/domains/developer-platform/api/v1.controller.ts#L34): BulkStockBody accepts 1-10,000 stock items for bulk stock updates. _(v1.controller.ts)_
> - [`PublicCatalogService`](../../packages/backend/libs/domains/developer-platform/application/public-catalog.service.ts#L80): PublicCatalogService implements bulk stock sync and async updates with Redis job tracking. _(public-catalog.service.ts)_
<!-- theory-links:end -->

### 2.6 GraphQL
The client declares exactly the data graph it needs in one request.
- ✅ Solves over- and under-fetching for complex UIs, and the schema is strongly typed.
- ❌ It moves the N+1 problem **to the server**: resolvers per field. Fix it with **DataLoader** (batches and dedupes loads within one tick of a request):
  ```ts
  const projectStatsLoader = new DataLoader(async (ids: readonly number[]) => {
    const rows = await db.query('SELECT * FROM project_stats WHERE project_id = ANY($1)', [ids]);
    const byId = new Map(rows.map(r => [r.project_id, r]));
    return ids.map(id => byId.get(id) ?? null);    // must preserve order & length
  });
  // per-request instance! (cache must not leak between users)
  ```
- ❌ Caching is harder (POST, a single endpoint): use **persisted queries** (hash → query, which enables GET + CDN caching) and normalized client caches (Apollo, urql).
- ❌ Security: query depth and complexity limits, disabling introspection in production (debatable), per-field authorization, rate limiting by query cost.
- **Federation** composes several services' subgraphs into one graph (Apollo Federation). It works as an aggregation layer at organization scale.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`BffModule`](../../packages/backend/libs/composition/bff/bff.module.ts#L42): BffModule configures GraphQL with cost limits, persisted queries and loaders alongside the REST endpoints. _(bff.module.ts)_
> - [`createLoaders`](../../packages/backend/libs/composition/bff/graphql/loaders.ts#L16): createLoaders builds the batched shop and product DataLoaders that avoid server-side N+1. _(loaders.ts)_
> - [`costLimit`](../../packages/backend/libs/composition/bff/graphql/limits.ts#L10): costLimit is a GraphQL validation rule enforcing query depth and cost limits. _(limits.ts)_
<!-- theory-links:end -->

### 2.7 Client-side techniques
- **Request deduplication and caching**: TanStack Query / RTK Query / SWR dedupe identical in-flight requests and cache them by key, so three components asking for `/me` make one call.
- **Prefetching** on hover or route intent, and parallelizing independent requests (`Promise.all`, parallel queries) instead of waterfalls.
- **Keep sessions warm**: HTTP/2 or HTTP/3, keep-alive, and TLS session resumption.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CART_QUERY_KEY`](../../packages/web/lib/api/cart.ts#L20): CART_QUERY_KEY is the React Query cache key that lets the client dedupe and cache cart requests. _(cart.ts)_
> - [`refreshSession`](../../packages/web/lib/api/client.ts#L70): refreshSession is single-flight, so concurrent callers share one refresh request. _(client.ts)_
<!-- theory-links:end -->

### 2.8 Push instead of poll
Polling every 5 s is the chattiest pattern of all.
- **Webhooks** (server to server), **SSE** (server to browser, one-way, simple, works over HTTP), **WebSockets** (bidirectional), long polling (fallback).
- Send a lightweight "something changed" notification and let the client fetch, or push the change itself.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AssistantStreamer`](../../packages/backend/libs/domains/assistant/api/assistant-stream.ts#L16): AssistantStreamer pipes generation events to SSE responses with gap-free replay, so the client doesn't poll. _(assistant-stream.ts)_
> - [`streamSse`](../../packages/web/lib/api/sse-reader.ts#L46): streamSse reads an SSE stream on the web client and invokes a callback per event. _(sse-reader.ts)_
> - [`useEventStream`](../../packages/web/hooks/use-event-stream.ts#L6): The useEventStream hook subscribes React components to the SSE stream. _(use-event-stream.ts)_
<!-- theory-links:end -->

#### What an SSE stream is (Server-Sent Events)
**Supported on HTTP/1.1, HTTP/2, and HTTP/3.** SSE was designed in the HTML5 era (~2009) for **HTTP/1.1**, and it needs nothing new from the protocol: it's just a response that takes a long time to finish (sent with chunked transfer encoding, i.e. no `Content-Length`, so the client reads it as it arrives). On HTTP/2 and HTTP/3 it works the same way, as one stream. The only practical difference: on **HTTP/1.1 each open SSE stream holds one of the browser's 6 connections** to that site (§1.1). On HTTP/2 it's just one of ~100 streams on the shared connection. Either way, make sure no proxy buffers or compresses the response, or events arrive in delayed batches.

A normal HTTP request returns **one response and ends**. With **SSE**, the client makes **one ordinary GET request**, and the server **keeps the response open**, writing small text **events** into it whenever it has something new, for seconds, minutes, or hours. It's a standard browser API (`EventSource`), and it runs over plain HTTP. No special protocol is needed.

Wire format (`Content-Type: text/event-stream`): each event is a few `field: value` lines, ending with a **blank line**:
```
id: 1
event: progress
data: {"pct":25}

id: 2
event: progress
data: {"pct":50}

```
Verified with a Node server and `fetch` reading the response body: one response, the four events arriving at **+1 ms, +91 ms, +191 ms, +293 ms** as the server wrote them every ~100 ms, then the stream ended.

Server (Node/Express):
```ts
app.get('/jobs/:id/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown, id?: string) =>
    res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const unsubscribe = jobEvents.subscribe(req.params.id, (e) => send('progress', e, e.seq));  // e.g. Redis pub/sub
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);   // comment line keeps proxies from closing it
  req.on('close', () => { unsubscribe(); clearInterval(heartbeat); });    // client left → clean up (avoid leaks)
});
```
Browser (React):
```ts
useEffect(() => {
  const es = new EventSource(`/jobs/${jobId}/events`, { withCredentials: true });   // cookies are sent
  es.addEventListener('progress', (e) => setProgress(JSON.parse(e.data)));
  es.onerror = () => { /* browser AUTO-RECONNECTS by itself */ };
  return () => es.close();
}, [jobId]);
```

Features and limits:
- **One-way: server → client only.** To send something to the server, the client makes normal HTTP requests.
- **Automatic reconnection** built into `EventSource`: if the connection drops, the browser reconnects and sends the header `Last-Event-ID: <last id it got>`, so the server can **resume** from where it left off. The server can set the retry delay with `retry: 5000`.
- **Text only** (UTF-8). Binary has to be base64-encoded.
- `EventSource` can only do **GET** and can't set custom headers like `Authorization`. It relies on cookies (or a token in the URL, which is worse: it leaks into logs). Libraries such as `@microsoft/fetch-event-source`, or reading `fetch()`'s body stream directly, work around this. That's how **LLM chat UIs stream tokens** (POST + streamed response).
- **Under HTTP/1.1 each open SSE stream occupies one of the browser's 6 connections per origin** for as long as it's open (§1.1). Under HTTP/2 it's just one stream on the shared connection.
- Server-side: each client is an open connection, so with many replicas you need a fan-out backplane (Redis pub/sub) to deliver an event to whichever pod holds that client's connection. Proxies and load balancers need buffering off (`X-Accel-Buffering: no` for nginx) and idle timeouts above the heartbeat interval.

| | Polling | Long polling | **SSE** | WebSocket |
|---|---|---|---|---|
| Direction | client asks repeatedly | client asks, server holds response until news | **server → client stream** | **both directions** |
| Protocol | HTTP | HTTP | **plain HTTP** (works with existing auth cookies, proxies, HTTP/2) | separate protocol after an HTTP `Upgrade` |
| Reconnect / resume | n/a | manual | **built in** (`Last-Event-ID`) | manual |
| Typical use | rare updates, simple | legacy fallback | notifications, job progress, live dashboards, **LLM token streaming** | chat, multiplayer, collaborative editing, anything client-heavy and bidirectional |

Rule of thumb: if the client mostly **listens**, use SSE (simpler, plain HTTP). Use WebSockets only when the client also has to **send** frequent low-latency messages over the same channel.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`src/main.ts`](../../packages/backend/apps/sse-gateway/src/main.ts): The sse-gateway app bootstraps a dedicated NestJS service that serves SSE streams.
> - [`SseParser`](../../packages/web/lib/api/sse-reader.ts#L14): SseParser incrementally parses text/event-stream chunks on the client. _(sse-reader.ts)_
<!-- theory-links:end -->

### 2.9 Async request-reply for long operations
```
POST /reports            → 202 Accepted, Location: /reports/jobs/abc
GET  /reports/jobs/abc   → { status: "running", progress: 0.4 }  (poll with Retry-After, or webhook/SSE on completion)
GET  /reports/jobs/abc   → 303 See Other → /reports/123
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PushDto`](../../packages/backend/libs/domains/catalog-sync/api/sync.controller.ts#L22): The catalog-sync PushDto belongs to the async sync and import flow. _(sync.controller.ts)_
> - [`Domain_AssistantTurnInProgress`](../../packages/backend/libs/domains/assistant/application/assistant-errors.ts#L27): Domain_AssistantTurnInProgress returns 409 while a long-running reply is still being generated. _(assistant-errors.ts)_
<!-- theory-links:end -->

### 2.10 Server-side read models (CQRS)
When an aggregate endpoint keeps needing expensive joins across services, **precompute** a denormalized read model (a materialized view, or a projection table updated from events) that serves the screen in one indexed query.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductSearchProjector`](../../packages/backend/libs/domains/catalog/infra/product-search.projector.ts#L23): ProductSearchProjector builds the product search read model in Elasticsearch as a CQRS projection. _(product-search.projector.ts)_
> - [`ProjectionCheckpoints`](../../packages/backend/libs/infrastructure/projections/read-your-writes.ts#L19): ProjectionCheckpoints tracks projection versions so reads can wait for the read model to catch up. _(read-your-writes.ts)_
> - [Shop balance and payout history reads](../../docs/humans/concepts/domain-payments/shop-balance-read-model.md): Shop balances are served from a Redis projection of ledger journals instead of being computed on read. [`BalanceProjector`](../../packages/backend/libs/domains/payments/infra/balance.projector.ts#L26), [`FinanceController`](../../packages/backend/libs/domains/payments/api/finance.controller.ts#L13)
<!-- theory-links:end -->

### 2.11 Internal service-to-service chattiness
- Microservices calling each other in loops ("distributed N+1") cost both latency and availability.
- Fixes: bulk internal APIs, caching reference data locally, event-carried state transfer (subscribe to events and keep a local copy of the data you need), rethinking service boundaries (chatty services are often a **wrong split**), and gRPC for efficient internal RPC (HTTP/2, protobuf, streaming).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductBatchReadController`](../../packages/backend/libs/domains/catalog/api/product-batch-read.controller.ts#L14): ProductBatchReadController serves batch product reads through DataLoaders for internal callers. _(product-batch-read.controller.ts)_
> - [`ShopBatchReadController`](../../packages/backend/libs/domains/tenancy/api/shop-batch-read.controller.ts#L14): ShopBatchReadController serves GET /batch/shops with batch ID lookups and caching. _(shop-batch-read.controller.ts)_
<!-- theory-links:end -->

### Decision guide

| Situation | Approach |
|---|---|
| One screen needs data from 5 services, web + mobile differ | BFF per client with aggregate endpoints |
| Public API, many unknown consumers | REST resources + `include`/`fields` + bulk endpoints; stable, cacheable |
| Complex, evolving UI with nested data | GraphQL + DataLoader + persisted queries |
| Loops over IDs | bulk endpoint `?ids=` / `ANY($1)` |
| Polling for status | webhooks / SSE / WebSocket |
| Expensive cross-domain read | precomputed read model |

---

## 3. REST fundamentals asked at senior level

### Method semantics
| Method | Safe | Idempotent | Notes |
|---|---|---|---|
| GET/HEAD | ✅ | ✅ | never change state (CSRF and prefetchers will call them!) |
| PUT | ❌ | ✅ | full replace |
| DELETE | ❌ | ✅ | repeat → 404 or 204, state same |
| PATCH | ❌ | not necessarily | JSON Merge Patch (RFC 7386: `null` deletes) vs JSON Patch (RFC 6902: ops list) |
| POST | ❌ | ❌ | make idempotent with `Idempotency-Key` |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`IdempotencyInterceptor`](../../packages/backend/libs/infrastructure/idempotency/idempotency.interceptor.ts#L30): IdempotencyInterceptor makes POST requests idempotent through the Idempotency-Key header and Redis. _(idempotency.interceptor.ts)_ · [idempotency](../../docs/humans/concepts/platform-idempotency/idempotency.md)
<!-- theory-links:end -->

### Status codes that show precision
- `201 Created` + `Location`; `202 Accepted` for async; `204 No Content`.
- `400` malformed syntax vs **`422`** semantically invalid (validation).
- `401` not authenticated vs **`403`** authenticated but not allowed. Return **`404` instead of 403** when you don't want to reveal that the resource exists.
- **`409 Conflict`**: state conflict, duplicate, version mismatch. **`412 Precondition Failed`**: `If-Match` failed. `428 Precondition Required`: you require `If-Match`.
- `429 Too Many Requests` + `Retry-After`. `503` + `Retry-After` for maintenance or load shedding.
- `410 Gone`: the endpoint was sunset (see the deprecation doc).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Domain_ConversationFull`](../../packages/backend/libs/domains/assistant/application/assistant-errors.ts#L33): Domain_ConversationFull returns 409 Conflict for a state conflict. _(assistant-errors.ts)_
> - [`Domain_AssistantQuotaExceeded`](../../packages/backend/libs/domains/assistant/application/assistant-errors.ts#L15): Domain_AssistantQuotaExceeded returns 429 with retry timing. _(assistant-errors.ts)_
<!-- theory-links:end -->

### Errors: RFC 9457 Problem Details
```json
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
{
  "type": "https://api.example.com/problems/validation-error",
  "title": "Validation failed",
  "status": 422,
  "detail": "2 fields are invalid",
  "instance": "/invoices",
  "errors": [{ "pointer": "/amountCents", "detail": "must be positive" }],
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AllExceptionsFilter`](../../packages/backend/libs/common/exceptions-filter/exceptions-filter.ts#L8): AllExceptionsFilter turns exceptions into consistent HTTP error responses. _(exceptions-filter.ts)_ · [exceptions-filter](../../docs/humans/concepts/common-exceptions-filter/exceptions-filter.md)
<!-- theory-links:end -->

### HTTP caching
- `Cache-Control: public, max-age=60, stale-while-revalidate=300` for CDN-cacheable data. `private, no-store` for user-specific sensitive data.
- **ETag** + `If-None-Match` → `304 Not Modified`, which saves bandwidth (and server work, if the ETag is cheap to compute, e.g. from `updated_at`/version).
- **ETag + `If-Match`** on writes gives optimistic concurrency over HTTP (prevents lost updates between users).
- `Vary: Authorization, Accept-Language`, so a CDN doesn't serve one user's response to another.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`VersionEtagInterceptor`](../../packages/backend/libs/infrastructure/cache/etag.interceptor.ts#L11): VersionEtagInterceptor implements weak ETag caching with 304 Not Modified responses. _(etag.interceptor.ts)_
<!-- theory-links:end -->

### Resource modeling
- Nouns, plural collections, nesting no deeper than one level (`/projects/7/members`). Avoid `/a/1/b/2/c/3`.
- Actions that don't map to CRUD: model them as a sub-resource or state transition (`POST /invoices/123/send`, `POST /payments/9/refunds`), or Google's custom-method style `POST /invoices/123:send`.
- Consistent naming (camelCase or snake_case, pick one), ISO-8601 UTC timestamps, money as `{ amount: "12.34", currency: "EUR" }` or integer minor units.

---

## Interview Q&A

**Q: Why can a fast endpoint look slow in the browser under HTTP/1.1?**
HTTP/1.1 responses carry no request ID, so a connection can only have one request outstanding, and browsers allow only 6 connections per origin. If all 6 are held by slow requests, a fast request waits in the browser's own queue ("Stalled" in DevTools) until one frees up. The server sees 20 ms, the user waits 2 s. HTTP/2 tags frames with stream IDs, so the request goes out immediately on the same connection.

**Q: What is SSE and when would you use it over WebSockets?**
Server-Sent Events: one long-lived HTTP GET response in `text/event-stream` format, where the server pushes events over time. It's one-way, has auto-reconnect with `Last-Event-ID` resume, and works with cookies, proxies, and HTTP/2. Use it when the client mostly listens (notifications, job progress, LLM token streaming). Use WebSockets when the client also sends frequent messages (chat, collaboration).

**Q: What did HTTP/2 change compared with HTTP/1.1, and does it solve chatty APIs?**
HTTP/1.1 handles one request at a time per connection, so a slow response blocks the ones queued behind it (head-of-line blocking), and browsers open about 6 connections per origin, each paying TCP+TLS handshakes. HTTP/2 multiplexes many streams over one connection: frames interleave, responses arrive independently, and headers are compressed. It doesn't fix TCP-level HOL blocking on packet loss (HTTP/3/QUIC does), dependency chains (dependent calls still cost a round trip each), or per-request server work. So chatty APIs still need aggregation, a BFF, or batching.

**Q: Our mobile app makes 20 calls to render the home screen. How would you fix it?**
First I'd measure: which calls are sequential, which are N+1, and what they cost. Then: (1) add a BFF/aggregate endpoint for the home screen that fans out server-side in parallel, with per-dependency timeouts and partial responses for optional widgets; (2) replace loops with bulk endpoints (`?ids=`) and fix server-side N+1 with batched queries/DataLoader; (3) client-side dedupe and caching (React Query), prefetching, and parallel instead of waterfall requests; (4) replace polling with push; (5) if the aggregate needs expensive cross-service joins, precompute a read model. I'd also look at the trade-offs: coupling to the screen, cache granularity, tail latency.

**Q: Aggregate endpoint vs GraphQL?**
Aggregates are simple, cacheable, and optimized for a known use case, but each new screen shape needs server work. GraphQL lets clients compose their own shapes, which helps with many evolving clients, at the cost of server-side complexity (DataLoader, complexity limits, harder caching and authorization). For one or two first-party clients, a BFF with aggregates is often simpler. For many teams and clients, consider GraphQL/Federation.

**Q: How do you avoid N+1 in a GraphQL server?**
A DataLoader per request that batches all `load(id)` calls made in the same tick into one `WHERE id = ANY($1)` query, returns results in key order, and caches them for the request only.
