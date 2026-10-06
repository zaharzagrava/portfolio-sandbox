# Error Handling, Process Lifecycle, Graceful Shutdown

---

## 1. Error taxonomy

| Kind | Examples | Handling |
|---|---|---|
| **Operational** (expected) | DB timeout, 3rd-party 503, validation failure, not found, conflict | handle: retry, map to 4xx/5xx, degrade |
| **Programmer** (bugs) | `undefined is not a function`, broken invariant | don't try to "recover"; log, return 500, fix the bug. If process state may be corrupted, **crash and restart** |

Typed domain errors give you clean mapping:
```ts
export class DomainError extends Error {
  constructor(public readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);            // ES2022 error cause: preserve the chain
    this.name = new.target.name;
  }
}
export class NotFoundError extends DomainError {}
export class ConflictError extends DomainError {}
export class UpstreamUnavailableError extends DomainError {}

try { await bank.transfer(...) }
catch (e) { throw new UpstreamUnavailableError('BANK_DOWN', 'Bank API unavailable', { cause: e }); }
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ErrorArea`](../../packages/backend/libs/common/errors/error.types.ts#L53): ErrorArea enum splits errors into DOMAIN (business responses), FATAL (exceptions) and TRANSIENT (retryable), which matches the operational vs programmer taxonomy. _(error.types.ts)_ · [errors](../../docs/humans/concepts/common-errors/errors.md)
> - [`Fatal_DomainErrorIsThrown`](../../packages/backend/libs/common/errors/error.types.ts#L233): Fatal_DomainErrorIsThrown is a safety error raised when a domain error escapes where only handled errors belong, so it is treated as a bug. _(error.types.ts)_ · [errors](../../docs/humans/concepts/common-errors/errors.md)
> - [errors](../../docs/humans/concepts/common-errors/errors.md): The errors module provides the shared error types and utility services used across the app.
<!-- theory-links:end -->

---

## 2. Async error propagation rules

- A rejected promise with no handler raises `unhandledRejection`. **Since Node 15 the default is `--unhandled-rejections=throw`**, so the process crashes.
- A thrown error that nothing catches raises `uncaughtException`. The process state is **undefined**, so log and exit.
- An `EventEmitter` `'error'` with no listener throws.
- Express 4 doesn't catch async handler rejections (you need `express-async-errors` or wrappers). **Express 5** forwards rejected promises to the error middleware. NestJS handles async errors natively through exception filters.

```ts
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandledRejection');
  throw reason;                       // escalate to uncaughtException path
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException, exiting');
  // flush logs, then exit non-zero; orchestrator restarts us
  shutdown(1);
});
```

**Don't** keep running after an `uncaughtException`. You may have half-finished transactions or broken invariants.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`installCrashHandlers`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L88): installCrashHandlers registers unhandledRejection and uncaughtException handlers that log and force exit. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [`OutboxService`](../../packages/backend/libs/infrastructure/outbox/outbox.service.ts#L11): OutboxService retries failed events and routes them to a dead-letter queue, handling async failures explicitly. _(outbox.service.ts)_
<!-- theory-links:end -->

---

## 3. Mapping errors to HTTP safely (NestJS)

```ts
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = req.headers['x-request-id'];

    const { status, code, detail } = mapError(exception);  // NotFoundError→404, ConflictError→409, ...
    if (status >= 500) logger.error({ err: exception, requestId }, 'unhandled error');
    else logger.warn({ code, requestId }, 'client error');

    res.status(status).type('application/problem+json').json({
      type: `https://api.example.com/errors/${code}`,
      title: code,
      status,
      detail: status >= 500 ? 'An unexpected error occurred.' : detail,   // never leak internals on 5xx
      instance: req.url,
      requestId,                                                            // user can quote it to support
    });
  }
}
```

(RFC 9457 Problem Details. See the Security doc on safer error messaging.)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AllExceptionsFilter`](../../packages/backend/libs/common/exceptions-filter/exceptions-filter.ts#L8): AllExceptionsFilter is the global Nest filter that normalizes errors, reports them to Sentry and OpenTelemetry, and returns safe responses. _(exceptions-filter.ts)_ · [exceptions-filter](../../docs/humans/concepts/common-exceptions-filter/exceptions-filter.md)
> - [`ErrorUtilsService`](../../packages/backend/libs/common/errors/error-utils/error-utils.service.ts#L13): ErrorUtilsService normalizes application errors and captures them to Sentry. _(error-utils.service.ts)_ · [errors](../../docs/humans/concepts/common-errors/errors.md)
> - [`BadRequestError`](../../packages/backend/libs/common/errors/error.types.ts#L274): BadRequestError and the other HTTP error classes in error.types.ts map errors to status codes. _(error.types.ts)_ · [errors](../../docs/humans/concepts/common-errors/errors.md)
<!-- theory-links:end -->

---

## 4. Graceful shutdown: the full sequence

Kubernetes sends **SIGTERM**, waits `terminationGracePeriodSeconds` (default 30 s), then sends **SIGKILL**.

**The race people miss:** removing a pod from Service endpoints happens *asynchronously* and in *parallel* with SIGTERM. kube-proxy, ingress controllers, and LBs can keep sending new requests for a few seconds after SIGTERM arrives. Closing the server immediately turns those requests into **connection refused / 502**.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`installGracefulShutdown`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L28): installGracefulShutdown handles SIGTERM/SIGINT by setting readiness to false, waiting a drain delay, closing the server, running shutdown hooks and exiting, with a hard timeout. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [`ShutdownRegistry`](../../packages/backend/libs/infrastructure/lifecycle/shutdown-registry.service.ts#L17): ShutdownRegistry runs registered shutdown tasks in ascending order, e.g. closing pools after the server drains. _(shutdown-registry.service.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [`ReadinessService`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L23): ReadinessService reports a shutdown state so the load balancer stops sending traffic. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
<!-- theory-links:end -->

### Correct order
```
SIGTERM received
  1. Mark not-ready (readiness endpoint → 503)                 [isShuttingDown = true]
  2. Keep serving for a few seconds while endpoints propagate   [preStop sleep 5–10s OR in-app delay]
  3. Stop accepting new connections: server.close()
  4. Close idle keep-alive sockets; let in-flight requests finish (with a deadline)
  5. Stop queue consumers from pulling new messages; finish/abandon in-flight
     (SQS: stop polling, let visibility timeout return unfinished messages)
  6. Flush telemetry/logs, close DB pools, Redis, Kafka producers
  7. process.exit(0) — before the grace period ends
  Hard timeout: if still alive after N seconds → log & exit(1)
```

```ts
let shuttingDown = false;
app.get('/health/ready', (_req, res) => res.status(shuttingDown ? 503 : 200).end());

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => { logger.error('forced shutdown'); process.exit(1); }, 25_000).unref();

  await sleep(5_000);                       // let LB/endpoints notice (or use preStop hook instead)
  await new Promise<void>((r) => { server.close(() => r()); server.closeIdleConnections(); });
  await consumer.stop();
  await Promise.allSettled([pool.end(), redis.quit(), otelSdk.shutdown()]);
  clearTimeout(force);
  process.exit(code);
}
process.once('SIGTERM', () => shutdown(0));
process.once('SIGINT', () => shutdown(0));
```

K8s side:
```yaml
spec:
  terminationGracePeriodSeconds: 45
  containers:
    - name: api
      lifecycle:
        preStop:
          exec: { command: ["sh", "-c", "sleep 10"] }   # or httpGet / sleep action (k8s 1.30+ has native `sleep`)
```
`preStop` runs **before** SIGTERM is delivered, and it counts **against** the grace period.

NestJS: call `app.enableShutdownHooks()`, then implement `OnApplicationShutdown`/`BeforeApplicationShutdown`. Hooks are disabled by default because they add signal listeners.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`GracefulShutdownOptions`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L7): GracefulShutdownOptions sets drainDelayMs, hardTimeoutMs and keepAliveTimeoutMs for the shutdown order. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md): The lifecycle module wires graceful shutdown and crash handlers together with load balancer integration.
<!-- theory-links:end -->

### PID 1 problem in Docker
- If `CMD npm start` is the entrypoint, **npm** is PID 1, and it may not forward SIGTERM to node. You get no graceful shutdown and a SIGKILL after 30 s.
- A process running as PID 1 also doesn't get the kernel's default signal handlers. Node *does* handle SIGTERM if you register a handler, but zombie reaping still doesn't happen.
- Use `CMD ["node", "dist/main.js"]` (exec form, no shell), and/or `docker run --init` / `tini`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md): The lifecycle platform module covers signal handling, and the project notes a Dockerfile using tini for PID 1.
<!-- theory-links:end -->

---

## 5. Startup ordering

- Validate config and env first, and **fail fast**.
- Connect to dependencies with **retries and backoff**, or lazily. Don't crash-loop because Postgres needs 2 s to accept connections.
- Don't run DB migrations on every pod's startup: with N replicas they race, and a slow migration hangs startup until probes kill the pod. Run migrations as a **separate Job / ArgoCD PreSync hook**.
- Warm up caches and connection pools, then report ready.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EnvConfig`](../../packages/backend/libs/common/config/types.ts#L7): EnvConfig defines the environment variables required at startup, which supports validating config first. _(types.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How do you make deploys zero-downtime for a Node API on K8s?**
Readiness probe, a preStop sleep (or an in-app delay) so endpoint removal propagates, SIGTERM handling that stops accepting new requests, drains in-flight ones and closes keep-alive sockets, then closes pools. terminationGracePeriod is longer than the drain time. RollingUpdate uses maxUnavailable 0 and maxSurge ≥1. DB migrations follow expand/contract so old and new pods can run side by side.

**Q: Should you catch `uncaughtException` and continue?**
No. Log with full context, flush, and exit non-zero. The state is unknown, and a supervisor (K8s) will restart the process. Recovering is for *operational* errors handled where they happen.

**Q: How do you avoid leaking internal errors to clients?**
A global exception filter maps known domain errors to specific 4xx codes. Everything else becomes a generic 500 body with a request/correlation ID, and the full error with stack and cause is logged server-side.
