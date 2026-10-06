# L02 — Node.js → where it's used

| Topic (notes 02/01–05) | Implemented in | Status |
|---|---|---|
| Event-loop lag detection (`monitorEventLoopDelay`) + load shedding | F-01 | planned |
| libuv thread pool sizing (`UV_THREADPOOL_SIZE` for argon2/crypto/fs) | SD-39 (argon2), O-02 Dockerfile env | planned |
| `child_process.spawn` with streams/timeouts | SD-26 ffmpeg | planned |
| `worker_threads` | only if profiling shows CPU-bound hot spots — candidate: SD-40 test runs pool (isolated-vm in workers); otherwise skipped (D7) | planned |
| AsyncLocalStorage request context | F-01 (`nestjs-cls`) | planned |
| HTTP keep-alive agents, server timeouts (`keepAliveTimeout` > ALB idle) | F-01 http-client; O-02/O-03 ALB settings | planned |
| Streams & backpressure, `pipeline`, objectMode Transform | SD-27 import/export; SD-41 statement CSV; SD-05 sitemap | planned |
| Web Streams ↔ Node streams | SD-42 (Anthropic SDK stream → SSE) | planned |
| SSE / streaming responses | F-03, SD-42 | planned |
| Memory: heap limits in containers, heap snapshot on signal | O-02 (`--max-old-space-size`, `--heapsnapshot-signal`) | planned |
| Profiling & load testing | k6 per section; SD-33 dashboards | planned |
| Error taxonomy, async error propagation, mapping to HTTP | F-01 | planned |
| Graceful shutdown order, PID 1 (`tini`), startup ordering | F-01, O-02 | planned |
| Nest request lifecycle (middleware → guards → interceptors → pipes → filters) | F-01 interceptors/guards; SD-28 guard; SD-07 ApiKeyGuard | planned |
| DI scopes (avoid REQUEST scope on hot paths), dynamic modules | F-02 `forRootAsync` modules; SD-04 DataLoaders via CLS instead of request scope | planned |
| Transactions across services (CLS-managed) | F-01 | planned |
| Cron with replicas (leader election) | SD-29 | planned |
