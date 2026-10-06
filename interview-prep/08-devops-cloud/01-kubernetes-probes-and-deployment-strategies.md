# Kubernetes: Liveness vs Readiness vs Startup Probes, Deployments, Resources

> **Covers:** the difference between liveness, readiness and startup probes, and what each should (and should not) verify for dependencies like Postgres and Redis.

---

## 1. The three probes: exact definitions

| Probe | Question it answers | Action on failure | Scope of the check |
|---|---|---|---|
| **Startup** | "Has the app **finished starting**?" | keeps liveness/readiness **disabled** until it succeeds; if it never succeeds within `failureThreshold × periodSeconds` → container **restarted** | process boot completed (config loaded, server listening, migrations-awareness, warmup) |
| **Liveness** | "Is this process **irrecoverably broken** so that **restarting it** would help?" | kubelet **kills and restarts the container** | **only the process itself** (deadlock, wedged event loop, corrupted state) — **never external dependencies** |
| **Readiness** | "Should this pod **receive traffic right now**?" | pod removed from Service **endpoints** (no traffic); **not restarted**; re-added when it passes | can it serve requests *usefully*: warmed up, not shutting down, not overloaded, **hard dependencies that are pod-specific** usable |

Short versions to say out loud:
- **Liveness = "restart me".** **Readiness = "don't send me traffic".** **Startup = "give me time to boot".**
- A restart fixes only **local** problems. If a restart wouldn't fix it, it doesn't belong in liveness.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`HealthController`](../../packages/backend/libs/infrastructure/health/health.controller.ts#L15): HealthController exposes the separate /livez and /readyz endpoints, which are the liveness and readiness probes. _(health.controller.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
> - [`ReadinessService`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L23): ReadinessService runs the registered dependency checks and builds the readiness report. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
<!-- theory-links:end -->

---

## 2. Why liveness must not check Postgres or Redis

Scenario: liveness runs `SELECT 1` against Postgres.
1. Postgres has a 60-second failover, or is overloaded.
2. **Every pod's** liveness probe fails at the same time.
3. Kubelet **restarts every pod**. Restarts don't fix Postgres.
4. Pods come back, open new connections at the same moment (a thundering herd against a struggling DB), maybe run startup work, and fail liveness again → **CrashLoopBackOff** with exponential back-off delays (up to 5 minutes).
5. When Postgres recovers, your pods are sitting in back-off, so the **outage outlasts the DB incident**, and in-flight requests were killed on top of that.

**Rule: liveness checks only things inside the process.**

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ReadinessCheck`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L3): ReadinessCheck gives each dependency check a critical flag, so a dependency can be reported without making the pod unready. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
> - [`HealthController`](../../packages/backend/libs/infrastructure/health/health.controller.ts#L15): /livez is a separate endpoint from /readyz, which keeps liveness free of dependency checks. _(health.controller.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
<!-- theory-links:end -->

### What a liveness check should verify for a Node service
- The HTTP server answers (a trivial handler, which proves the **event loop isn't blocked** for longer than the probe timeout).
- Optionally, internal watchdogs: "the main worker loop ticked within the last N seconds" (for queue consumers), "event-loop delay below an extreme threshold (e.g. 10 s)", or "not in a known-corrupted state flagged by the app".
- **No** DB, Redis, downstream HTTP, or disk-space checks that are shared across pods.

```ts
app.get('/health/live', (_req, res) => res.status(200).send('ok'));     // fast, no I/O
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EventLoopMonitor`](../../packages/backend/libs/common/load-shedding/event-loop-monitor.service.ts#L12): EventLoopMonitor measures event-loop delay and publishes the p99, the in-process signal a liveness check would use. _(event-loop-monitor.service.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
<!-- theory-links:end -->

---

## 3. Readiness: what it should and shouldn't verify

Readiness controls **routing**. Removing a pod from endpoints makes sense when **that pod** can't serve but **other pods** can.

### Always include
- **Startup completed and warmed up**: config loaded, connection pools *created*, caches warmed if needed.
- **Shutting down → not ready**: flip to 503 on SIGTERM (see graceful shutdown).
- **Local overload** (optional): event-loop delay above a threshold, or in-flight requests at maximum, so the LB stops sending more to this pod for a while. Use with care: if every pod is overloaded, every pod goes unready.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`installGracefulShutdown`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L28): installGracefulShutdown sets readiness to false on SIGTERM, then drains and closes the server. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [`LoadSheddingMiddleware`](../../packages/backend/libs/common/load-shedding/load-shedding.middleware.ts#L15): LoadSheddingMiddleware returns 503 when event-loop lag exceeds a threshold, which is local overload protection. _(load-shedding.middleware.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
> - [`ReadinessReport`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L16): ReadinessReport carries the ready status and the shutdown state for the load balancer. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
<!-- theory-links:end -->

### Dependencies: the nuanced part (this is what they want to hear)

**The trap with shared dependencies**: if readiness fails whenever Postgres is down, **all pods go unready at once**. The Service has **zero endpoints**, and the ingress returns a generic 503 or "no healthy upstream". You lose:
- endpoints that **don't** need Postgres (health, static config, cached reads),
- the ability to return **meaningful errors** (Problem Details with a retry hint) or **degraded responses**,
- and recovery can be slower and flappy.

So the decision for each dependency is: **hard or soft, and pod-specific or shared?**

| Dependency | Liveness | Readiness | Reasoning |
|---|---|---|---|
| **Postgres** (primary datastore, shared by all pods) | ❌ never | ⚠️ **Generally don't fail readiness on a shared Postgres outage**, or do it **only with care**: a cheap check through the **existing pool** (`SELECT 1`, timeout < probe timeout, e.g. 500ms), with a high `failureThreshold`. Prefer to: fail readiness only for **pod-local** DB problems (e.g., this pod's pool can't get a connection while others can, broken connection pool, wrong credentials after secret rotation) | Removing all pods doesn't fix the DB; app should return fast 503 Problem Details via circuit breaker; pod-specific connectivity issues *are* readiness-worthy |
| **Postgres read replica** used by this pod | ❌ | maybe: if pod is pinned to a specific replica that's unreachable, unready so traffic goes to pods on healthy replicas | pod-specific |
| **Redis as cache** (soft dependency) | ❌ never | ❌ **no** — degrade to DB (with stampede protection), emit metric/alert | the app works without it, just slower |
| **Redis as session store / rate-limiter / required lock** (hard) | ❌ | ⚠️ same reasoning as Postgres: shared outage → all unready doesn't help; handle in app with fast failure; consider failing readiness only for pod-local connection problems | |
| **Redis/BullMQ for a worker** | ❌ | N/A (workers usually have no Service) — use liveness on **worker loop heartbeat**, and make the worker pause/backoff when Redis is down | |
| **External HTTP APIs** (bank, LLM, CRM) | ❌ never | ❌ never | circuit breakers + fallbacks; a third party being down must not drain your fleet |
| **Local disk / temp dir / loaded ML model** | possibly (if corruption requires restart) | ✅ yes (pod-local) | restart or reroute actually helps |

**A balanced answer you can give:**
> "Liveness only checks that the process is responsive, with no dependencies, because restarting pods doesn't fix a database. Readiness checks that this pod finished starting and isn't shutting down. For dependencies I separate hard from soft and pod-local from shared. Redis as a cache is soft, so it's never in readiness; we degrade to Postgres. For Postgres I might include a cheap `SELECT 1` through the existing pool with a short timeout and a tolerant failure threshold, so a pod whose connections are broken stops receiving traffic. But I'm aware that during a full DB outage, failing readiness everywhere empties the Service. So the app itself uses timeouts, circuit breakers, and fast 503 Problem Details responses rather than relying on probes for dependency failures."

Some teams **do** include Postgres in readiness (the default in many Spring Boot and Terminus examples). That's acceptable if you understand and accept the "all pods out" consequence, and it can even be desirable when a multi-region or multi-cluster LB can fail over to another region whose pods are healthy. Explain the trade-off rather than claiming one universal answer.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ReadinessCheck`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L3): ReadinessCheck has a critical flag, so only critical dependencies make the pod unready. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
> - [`ReadinessService`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L23): ReadinessService registers and runs the dependency checks and reports their results. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
> - [`HealthModule`](../../packages/backend/libs/infrastructure/health/health.module.ts#L15): HealthModule sets up the Postgres readiness check at startup. _(health.module.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
<!-- theory-links:end -->

### Implementation guidelines for health endpoints
- **Fast and cheap**: no new connections per probe (use the pool), no heavy queries, timeouts shorter than the probe's `timeoutSeconds` (**default 1 s!**).
- **Cache dependency results** for a few seconds, so probes from kubelet don't multiply DB load (N pods × probe frequency).
- Return details in the body (component statuses) for humans, while the kubelet only looks at the status code (200–399 = success).
- Separate endpoints: `/health/live`, `/health/ready`, `/health/startup`. Don't serve them on the public ingress, or protect them (they reveal internals).

```ts
// NestJS + @nestjs/terminus
@Controller('health')
export class HealthController {
  constructor(private health: HealthCheckService, private db: TypeOrmHealthIndicator, private lifecycle: LifecycleService) {}

  @Get('live') @HealthCheck()
  live() { return this.health.check([]); }                          // process responds = alive

  @Get('ready') @HealthCheck()
  ready() {
    return this.health.check([
      () => this.lifecycle.isShuttingDown()
              ? Promise.reject(new HealthCheckError('shutting down', {})) : Promise.resolve({ app: { status: 'up' } }),
      () => this.db.pingCheck('postgres', { timeout: 500 }),       // optional, see trade-offs above
      // NOTE: Redis cache intentionally NOT included (soft dependency)
    ]);
  }
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ReadinessReport`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L16): ReadinessReport returns per-component check results in the body for humans. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
> - [`ReadinessService`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L23): ReadinessService runs the dependency checks behind the health endpoints. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
<!-- theory-links:end -->

---

## 4. Probe configuration that won't hurt you

```yaml
containers:
  - name: api
    ports: [{ containerPort: 3000 }]
    startupProbe:
      httpGet: { path: /health/startup, port: 3000 }
      periodSeconds: 5
      failureThreshold: 24          # up to 120s to start
    livenessProbe:
      httpGet: { path: /health/live, port: 3000 }
      periodSeconds: 10
      timeoutSeconds: 3              # don't leave default 1s — GC pause/CPU throttle → false positive restarts
      failureThreshold: 3            # ~30s of consecutive failures before restart
    readinessProbe:
      httpGet: { path: /health/ready, port: 3000 }
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 2            # react quickly to unready
      successThreshold: 1
```
- Use `startupProbe` instead of a long `initialDelaySeconds` on liveness.
- Liveness should be **more tolerant** than readiness: readiness reacts fast, liveness only after sustained failure.
- **CPU throttling** under a tight CPU limit makes probes time out, which restarts pods under load and amplifies the incident. Watch throttling metrics.
- If you have no meaningful liveness check, **leave liveness off**. A crashed Node process exits on its own and gets restarted anyway. Liveness is for *hung* processes.

---

## 5. Deployment strategies

### Rolling update (default)
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate: { maxSurge: 25%, maxUnavailable: 0 }   # never reduce capacity during deploy
minReadySeconds: 10                                       # pod must stay ready 10s before counted available
```
- Old and new versions run **together**, so you need backward-compatible APIs, DB schemas (expand/contract), and message formats.
- `kubectl rollout undo` for rollback (in GitOps: revert the commit).

### Blue/green
- Bring up the full new stack (green), test it, switch traffic all at once (Service selector or LB), and keep blue for an instant rollback.
- ✅ Instant switch and rollback. ❌ Double capacity during the deploy, and the DB is still shared (schema compatibility is still required).

### Canary
- Send a small share of traffic (1% → 10% → 50% → 100%) to the new version with **automated analysis** on SLIs (error rate, latency) between steps, and roll back automatically if they regress.
- Tools: **Argo Rollouts** (fits with ArgoCD), Flagger, service-mesh traffic splitting.
```yaml
# Argo Rollouts snippet
strategy:
  canary:
    steps:
      - setWeight: 10
      - pause: { duration: 10m }
      - analysis: { templates: [{ templateName: error-rate-below-1pct }] }
      - setWeight: 50
      - pause: { duration: 10m }
```

### Feature flags
Decouple **deploy** from **release**: ship dark, enable per cohort, kill switch. Also the foundation of A/B tests and experimentation platforms.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FlagsAdminService`](../../packages/backend/libs/domains/experimentation/application/flags-admin.service.ts#L27): FlagsAdminService manages feature flags, including the kill switch, which separates deploy from release. _(flags-admin.service.ts)_
> - [`validateFlag`](../../packages/backend/libs/domains/experimentation/domain/evaluator.ts#L111): validateFlag validates variants and that rollout weights sum to 10,000, which supports percentage rollouts. _(evaluator.ts)_
<!-- theory-links:end -->

---

## 6. Resources, scaling, and availability

### Requests and limits
- **Requests** drive scheduling and the guaranteed share. **Limits** are a hard cap: going over the CPU limit means **throttling** (CFS quota); going over the memory limit means an **OOMKill**.
- Node is single-threaded for JS, but GC and libuv threads use extra CPU. Typical: request `cpu: 500m–1`, and either a limit of ≥ 1–2 cores or no CPU limit at all (a common recommendation to avoid throttling latency spikes, if the cluster policy allows it).
- Memory: `requests == limits` for predictability (Guaranteed QoS when the CPU settings match too). Set `--max-old-space-size` to about 75% of the limit.

### Horizontal Pod Autoscaler
- CPU-based HPA works for CPU-bound Node APIs. For I/O-bound ones, use **custom metrics**: RPS per pod, event-loop utilization, or **queue depth via KEDA** for workers.
- Set `maxReplicas` with your **DB connection budget** in mind (pods × pool ≤ connection limit).
- Scale-down stabilization to avoid flapping.

### Availability
- **PodDisruptionBudget** (`minAvailable: 2` or `maxUnavailable: 1`) so node drains and upgrades don't take every replica down.
- **topologySpreadConstraints / pod anti-affinity** across nodes and zones.
- At least 2–3 replicas for anything user-facing.

---

## 7. Config and secrets in K8s
- ConfigMaps for non-secret config, Secrets (encrypted at rest with KMS, synced by External Secrets Operator from AWS Secrets Manager).
- A config change doesn't restart pods automatically. Use a checksum annotation in Helm, or Reloader.

---

## Interview Q&A

**Q: Liveness vs readiness?**
Liveness asks whether the process is hung beyond repair: failure means restart, so it checks only in-process health. Readiness asks whether this pod should get traffic now: failure means it's removed from endpoints without a restart, and it covers warmup, shutdown, and pod-local inability to serve. Startup protects slow boots from liveness.

**Q: Should readiness check Postgres?**
Never liveness. For readiness it's a trade-off. A cheap pooled `SELECT 1` with a short timeout catches pod-specific connectivity problems. But during a shared outage every pod goes unready, the Service has no endpoints, and you lose graceful degradation and meaningful errors. I prefer handling shared-dependency failures in the app (timeouts, circuit breakers, 503 Problem Details), keeping readiness focused on pod-local conditions, and never including soft dependencies like a Redis cache.

**Q: How do you avoid dropped requests during rolling deploys?**
maxUnavailable 0, readiness gates, a preStop sleep so endpoint removal propagates, SIGTERM handling that drains connections, a grace period long enough for that, and backward-compatible schema and API changes.
