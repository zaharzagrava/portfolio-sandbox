# Web Platform Architectures

Designs 1–7 of the practice catalog (`03-practice-catalog.md`). These are less about massive scale and more about **web-platform mechanics**: origins, cookies, caching, deploys, tenants, and cost.

---

## 1. Embeddable widget / third-party script

**Prompt variants:** "Build an embeddable chat/support widget", "a comments widget customers put on their sites", "a 'Pay with X' button", "an analytics snippet".

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`loaderScript`](../../packages/edge-be/src/widget-loader.ts#L9): loaderScript returns the IIFE loader script string, parameterised by the API origin, that is injected into host pages. _(widget-loader.ts)_ · [edge-be](../../docs/humans/concepts/package-edge-be/edge-be.md)
> - [`WidgetController`](../../packages/backend/libs/domains/developer-platform/api/widget.controller.ts#L26): WidgetController serves the widget sites, config, identification and iframe embedding routes. _(widget.controller.ts)_
> - [`WidgetService`](../../packages/backend/libs/domains/developer-platform/application/widget.service.ts#L39): WidgetService manages widget site creation, authorization, identity handoff and config delivery. _(widget.service.ts)_
<!-- theory-links:end -->

### Clarify
- What does the host page embed: a **script tag**, an **iframe**, or both?
- Does the widget need the end user to be **logged in**, and logged in to *what*: our service, or the customer's site?
- Does it need to read or modify the host page (analytics, A/B testing), or should it be fully isolated (payments, chat)?
- Scale: number of customer sites, page views per day (the loader script is loaded on **every page view of every customer**).
- Assumptions: 10k customer sites, 500M page views/day → the loader is a CDN problem, while the chat backend sees far fewer active sessions.

### Design
```
Customer page (customer.com)
  <script src="https://cdn.widget.com/loader.v1.js" data-site-key="pk_123" async></script>
        │ 1. tiny loader (≈5 KB, cached at CDN, versioned)
        ▼
  injects <iframe src="https://app.widget.com/embed?site=pk_123">   ← the real app, on OUR origin
        │ 2. iframe ↔ host communicate via window.postMessage (validated origins)
        ▼
  app.widget.com  ──►  API (api.widget.com)  ──►  WebSocket/SSE gateway, DB, queues
```
Standard split, used by Intercom, Stripe Elements, and YouTube embeds:
- **Loader script** (runs in the host page's context): as small as possible. It reads config (`data-site-key`), creates the iframe and launcher button, and relays a few events. It doesn't contain app logic or touch secrets.
- **Iframe app** (runs on your origin): the actual UI. It's isolated from the host page's CSS and JS, and the host can't read its DOM (same-origin policy).
- **`postMessage` bridge** for resizing the iframe, open/close, passing identity info, and analytics events.

**Distribution: CDN script snippet vs npm package.** Offer both, but the snippet is the primary channel:

| | CDN `<script>` snippet | npm package (e.g. a React component) |
|---|---|---|
| Who can use it | any site: plain HTML, WordPress, Shopify, Webflow, Wix, tag managers. No build step needed | only sites with a JS build pipeline and that framework (React, Vue, Angular, and often specific versions via peer dependencies) |
| Updates | **you** control them: bug fixes, security patches, kill switch, and new features reach every customer within minutes | frozen at the version the customer installed until **they** upgrade; old versions stay in production for years and must keep working against your backend |
| Bundle impact | loaded async, outside the customer's bundle | adds to the customer's bundle; their bundler and config decide how it's built |
| Developer experience | global API (`window.WidgetSDK`), less type safety | typed API, idiomatic components, SSR awareness |
| Customer constraints | their CSP must allow your domains; some strict enterprises forbid third-party scripts | no external script (unless the package loads one) |

The npm package doesn't remove the need for an **iframe** either. Code from an npm package still runs in the customer's origin, exactly like the snippet, so isolation of your UI and data still requires the iframe. That's why most vendor npm packages are **thin wrappers** that load the real thing from the CDN:
- `@stripe/stripe-js` only injects `<script src="https://js.stripe.com/v3">`. Stripe requires Stripe.js to be loaded from its own domain for PCI compliance, so card fields stay in Stripe-hosted iframes and Stripe can update them for everyone.
- `@stripe/react-stripe-js` and Intercom's React packages are React bindings around that CDN-loaded script.

So: the real logic and UI live on your CDN and iframe (always current, isolated), and npm packages provide convenient, typed wrappers that rarely need changing. A pure npm library without a hosted part makes sense for things that have no backend or isolation needs, such as UI component libraries.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`loaderScript`](../../packages/edge-be/src/widget-loader.ts#L9): The loader script is the small piece that runs in the host page and creates the iframe. _(widget-loader.ts)_ · [edge-be](../../docs/humans/concepts/package-edge-be/edge-be.md)
> - [`WidgetController`](../../packages/backend/libs/domains/developer-platform/api/widget.controller.ts#L26): WidgetController provides the iframe embedding route served from the platform's own origin. _(widget.controller.ts)_
<!-- theory-links:end -->

### Deep dives
**Isolation and security**
- The iframe protects **your** UI from the host (their CSS can't break it, their JS can't read your data). The loader runs *inside* their page, so keep it minimal and never put secrets in it.
- `postMessage`: always check `event.origin` against the expected origin, and always pass an explicit `targetOrigin` (never `'*'`) when sending sensitive data.
- Your app pages must allow being framed **only** where intended: CSP `frame-ancestors` (list the customer domains registered for that site key, or `*` for public widgets, with care). Admin pages of your app: `frame-ancestors 'none'`.
- Public site key (`pk_…`) in the snippet vs secret key (`sk_…`) only on customers' backends. Validate that the requesting `Origin` matches the domains registered for that site key.

**Authentication inside a third-party iframe** (the hard part)
- Your iframe is **cross-site** relative to the host page, so your cookies are **third-party cookies**. Safari and Firefox block them, and Chrome restricts them too. A cookie session inside the iframe is unreliable.
- Options:
  1. **Token-based identity from the customer's backend** (preferred): the customer's server signs a short-lived JWT (`userId`, `email`, `exp`) with their secret key. The host page passes it into the widget, your backend verifies the signature with that customer's key, and the widget gets its own short-lived access token kept **in memory**, not in cookies. (Intercom "identity verification" works like this.)
  2. **Partitioned cookies (CHIPS)**: `Set-Cookie: sid=…; Secure; SameSite=None; Partitioned`. The cookie is stored separately per top-level site, which works for "per-embed session" state.
  3. **Storage Access API / popup login** for "log in with your account on our service" flows.
- If you do use cookies, they need `SameSite=None; Secure`, which means the endpoints need CSRF protection (`05-Security/01` §3.2 B, gap 3).

**Performance on someone else's page**
- Load **async/defer**, never block their rendering. Lazy-create the iframe on first interaction (show only a launcher button until clicked).
- Loader caching: `loader.v1.js` with a short TTL (minutes) so fixes roll out, loading content-hashed immutable chunks (`app.3f9a.js`, `Cache-Control: immutable`).
- A budget for the snippet size, and no global namespace pollution (wrap in an IIFE, use one global like `window.WidgetSDK`).
- Customers' CSPs may block you: document what they must allow (`script-src cdn.widget.com; frame-src app.widget.com; connect-src api.widget.com`).

**Versioning and rollout**
- Breaking the loader breaks thousands of sites at once. Use major-versioned URLs (`/v1/`), canary by site key, a kill switch, and error reporting from the loader (with a sampling rate).

**Backend**
- Real-time chat → WebSocket or SSE gateway (design 14). Per-site-key rate limits (design 28). Per-customer config cached at the edge.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`normalizeOrigin`](../../packages/backend/libs/domains/developer-platform/application/widget.service.ts#L28): normalizeOrigin validates and normalizes HTTPS origins to scheme://host[:port] for the allowed-origin list. _(widget.service.ts)_
> - [`WidgetSite`](../../packages/backend/libs/domains/developer-platform/application/widget.service.ts#L11): WidgetSite holds the allowed origins and the killSwitch for each site. _(widget.service.ts)_
> - [`KillSwitchDto`](../../packages/backend/libs/domains/developer-platform/api/widget.controller.ts#L20): KillSwitchDto lets a site's widget be switched on or off remotely. _(widget.controller.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Script injection (no iframe) gives tighter integration but no isolation: host CSS collides, and a host XSS can read your widget's data. Use it only for things that must touch the host DOM (analytics, A/B).
- Pitfalls: relying on third-party cookies; `postMessage` without origin checks; huge synchronous loader; no `frame-ancestors`, so anyone can frame your app (clickjacking).

### Theory
`05-Security/01` (CSP `frame-ancestors`, CSRF with `SameSite=None`, XSS), `05-Security/02` (JWT validation), `01-JavaScript-TypeScript/01` §1.4 (iframes/workers/origins), `09-Frontend-React-Next/02` (performance).

---

## 2. Multi-tenant B2B SaaS

**Prompt variants:** "Design a B2B SaaS where companies sign up and invite their teams", "Make our single-customer app multi-tenant", "How do you isolate customer data?"

### Clarify
- Number of tenants and size distribution (many small ones + a few huge enterprises?).
- Isolation and compliance requirements: SOC 2, GDPR, data residency (EU tenants in EU), "dedicated database" requests from enterprises.
- Roles within a tenant (admin, member, viewer, custom roles?), and SSO (SAML/OIDC) for enterprise tenants.
- Assumptions: 5k tenants, largest 20k users, 95% under 50 users.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopSsoService`](../../packages/backend/libs/domains/tenancy/application/shop-sso.service.ts#L13): ShopSsoService manages per-shop enterprise SSO (OIDC) configuration with encrypted credentials. _(shop-sso.service.ts)_
> - [`ShopInvite`](../../packages/backend/libs/domains/tenancy/infra/models/shop-invite.model.ts#L7): ShopInvite models invitations of team members into a shop. _(shop-invite.model.ts)_
<!-- theory-links:end -->

### Design
```
tenant-a.app.com / app.com/t/acme ─► Edge (CDN/WAF) ─► API (NestJS, stateless)
                                                         │ resolve tenant (subdomain / token claim)
                                                         │ AsyncLocalStorage: { tenantId, userId, roles }
                                                         ▼
                                     Postgres (shared schema, tenant_id on every row, RLS)
                                     Redis (keys prefixed by tenant), S3 (prefix per tenant)
                                     Queue (jobs carry tenantId; fair scheduling per tenant)
```
Isolation models:

| Model | Isolation | Cost / ops | When |
|---|---|---|---|
| **Shared tables + `tenant_id`** | logical (app + RLS) | cheapest, one migration | default for most SaaS |
| Schema per tenant | stronger | migrations × N schemas, connection/catalog bloat at thousands | tens–hundreds of tenants |
| Database per tenant | strongest, per-tenant backup/restore/residency | expensive, fleet management | enterprise tier, compliance |
| **Hybrid** (pooled for SMB, dedicated for enterprise) | per tier | routing layer needed | common at scale |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TenantConnectionResolver`](../../packages/backend/libs/domains/tenancy/infra/tenant-connection.resolver.ts#L16): TenantConnectionResolver resolves each shop to a pooled or dedicated database cell. _(tenant-connection.resolver.ts)_
> - [`ShopDirectory`](../../packages/backend/libs/domains/tenancy/infra/models/shop-directory.model.ts#L5): ShopDirectory maps a shop tenant to its cell (pooled or dedicated) and region. _(shop-directory.model.ts)_
<!-- theory-links:end -->

### Deep dives
**Tenant isolation (the core question)**
- Resolve the tenant once per request (subdomain, path, or a JWT claim) and **verify the user belongs to it**. Never trust a `tenantId` sent in the request body.
- Put it in request context (AsyncLocalStorage / `nestjs-cls`) so repositories add `WHERE tenant_id = $ctx` automatically.
- **Postgres RLS** as a backstop: `USING (tenant_id = current_setting('app.tenant_id')::bigint)`, set with `SET LOCAL` per transaction (never session-level with a pooler).
- Composite indexes **leading with `tenant_id`**, and unique constraints scoped per tenant (`UNIQUE (tenant_id, email)`).
- Every cache key, S3 path, search index document, queue job, and log line carries `tenantId`.
- Tests: cross-tenant access tests on every endpoint (user from tenant A requesting tenant B's IDs gets 404).

**Authorization inside a tenant**
- RBAC per tenant (`memberships(user_id, tenant_id, role)`), plus record-level rules (§7 of the auth doc). Users can belong to multiple tenants (agencies, consultants), so the role is per membership.
- Enterprise SSO: SAML/OIDC per tenant, plus SCIM for automatic user provisioning/deprovisioning.

**Noisy neighbors**
- Per-tenant rate limits and quotas (API calls, storage, seats).
- Fair queueing for background jobs: per-tenant concurrency caps, so one tenant's 1M-row import doesn't delay everyone's emails.
- Heavy tenants → move to dedicated resources (read replica, their own DB) behind the same routing layer.
- Per-tenant metrics (but not as a high-cardinality Prometheus label for thousands of tenants; use logs/traces, or a top-N).

**Tenant lifecycle and data**
- Onboarding (create tenant, seed data, admin invite), plan limits, offboarding (export + hard delete for GDPR, within N days).
- Data residency: route EU tenants to an EU deployment (cell per region). The tenant directory maps tenant → region/cell.
- Per-tenant backup restore is hard in shared tables. Design soft-delete/archival and point-in-time export tools.

**Config and customization**
- Feature flags per tenant/plan (design 38), custom fields via JSONB (with validation), branding, custom domains (TLS via ACME, CNAME verification).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopTransactionRunner`](../../packages/backend/libs/domains/tenancy/infra/shop-transaction.ts#L14): ShopTransactionRunner runs transactions with the tenant set for Postgres RLS, or with an audited cross-tenant bypass. _(shop-transaction.ts)_
> - [`ShopGuard`](../../packages/backend/libs/domains/tenancy/api/shop.guard.ts#L28): ShopGuard verifies shop membership and permissions before a request runs. _(shop.guard.ts)_
> - [`ShopService`](../../packages/backend/libs/domains/tenancy/application/shop.service.ts#L21): ShopService enforces multi-tenant access boundaries, memberships, invitations and roles. _(shop.service.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Shared schema is cheap and simple, but one missing `WHERE tenant_id` leaks data. Mitigate with RLS + context-scoped repositories + tests.
- Pitfalls: tenant ID from the client; global unique constraints (an email can only exist once in the whole system); cron jobs that iterate all tenants serially; no per-tenant limits.

### Theory
`05-Security/02` §7 (record-level security, RLS, BOLA), `03-Databases/03` (multi-tenancy, partitioning), `02-Node.js/05` (CLS context), `06-Distributed-Systems/03` (bulkheads), `04-API-Design/03` (rate limiting).

---

## 3. Serverless application

**Prompt variants:** "Build X fully serverless on AWS", "When would you choose Lambda over containers?", "Design an event-driven pipeline with Lambda".

### Clarify
- Traffic shape: spiky/unpredictable (serverless shines) or steady high (containers are cheaper)?
- Latency requirements (cold starts matter for user-facing p99)?
- Long-running work (Lambda max 15 min) or WebSockets (API Gateway WebSocket API has its own model)?
- Assumptions: an internal tool / SaaS API with 50 req/s average and 2k req/s spikes, plus async document processing.

### Design
```
Browser ─► CloudFront (static SPA from S3) ─► API Gateway (HTTP API, JWT authorizer)
                                                  │
                                                  ▼
                                        Lambda handlers (one per route group)
                                          │            │              │
                                          ▼            ▼              ▼
                                   DynamoDB or      S3 (files)    EventBridge / SQS
                                   Aurora + RDS Proxy                │
                                                                     ▼
                                                     Worker Lambdas (SQS trigger) / Step Functions
                                                                     │
                                                                     ▼
                                                     SNS/SES notifications, DLQs + CloudWatch alarms
```
Building blocks: **API Gateway** (HTTP API is cheaper and faster; REST API has more features: usage plans, request validation, WAF), **Lambda**, **DynamoDB** (pairs naturally: no connection limits, scales per request) or **Aurora + RDS Proxy**, **S3**, **SQS/SNS/EventBridge**, **Step Functions** for workflows, **Cognito** or an external IdP for auth.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LAMBDAS`](../../packages/backend/apps/lambdas/src/lambdas.manifest.ts#L19): LAMBDAS lists the three SQS-triggered Lambda specs: webhook-delivery, media-processing and document-extractor. _(lambdas.manifest.ts)_
> - [`LambdaSpec`](../../packages/backend/apps/lambdas/src/lambdas.manifest.ts#L7): LambdaSpec defines each function's queue, timeout, memory, batch size and max concurrency. _(lambdas.manifest.ts)_
<!-- theory-links:end -->

### Deep dives
**Cold starts**
- First request on a new execution environment pays for runtime start + your init code (module loading, SDK clients). Node: typically ~100–500 ms plus your init.
- Reduce: small bundles (esbuild, tree-shaken AWS SDK v3 clients), lazy-load rarely used modules, init clients **outside the handler** so warm invocations reuse them, avoid heavy frameworks per function (full NestJS bootstrap in Lambda is slow; if you use it, cache the app instance across invocations).
- For latency-critical paths: **provisioned concurrency** (pre-warmed environments, at a cost).

**Database connections**
- Each concurrent Lambda environment holds its own connection. A spike of 1,000 concurrent invocations → 1,000 Postgres connections → `too many connections`.
- Fixes: **RDS Proxy** (pools and multiplexes), **reserved concurrency** to cap fan-out, DynamoDB (HTTP-based, no connection pool), or Aurora Data API.

**Async processing and failures**
- Synchronous request does minimal work, publishes an event, returns `202`. Workers consume from SQS with **partial batch failure** reporting, a **DLQ**, and a visibility timeout ≥ 6× the function timeout.
- Everything async is **at-least-once**, so handlers must be idempotent (Powertools Idempotency utility with DynamoDB).
- Multi-step workflows (process → approve → notify, with waits and compensation) → **Step Functions** instead of chains of Lambdas calling each other.

**Limits to design around**
- 15-minute max duration, payload limits (API Gateway 10 MB, sync Lambda invoke 6 MB) → large files go straight to S3 via presigned URLs.
- API Gateway integration timeout (29 s default) → long operations must be async.
- Account-level concurrency limit (shared by all functions) → reserved concurrency for critical functions.

**Cost model**
- Pay per request and GB-second, with zero cost when idle. Great for spiky or low traffic.
- At steady high load, containers (ECS/EKS) are usually cheaper. Also watch the hidden costs: NAT Gateway for Lambdas in a VPC, CloudWatch Logs volume, API Gateway per-request pricing.

**Deploy and observability**
- IaC: AWS CDK / SAM / Serverless Framework / Terraform. Per-PR stacks are cheap with serverless.
- Powertools for structured logs, metrics (EMF), and traces (X-Ray/OTel). Alarms: errors, throttles, DLQ depth, iterator age, duration p99.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`nestContext`](../../packages/backend/apps/lambdas/src/shared/nest-context.ts#L12): nestContext retrieves or creates a cached Nest application context, so it is initialised outside the handler and reused on warm invocations. _(nest-context.ts)_
> - [`scripts/build-lambdas.mjs`](../../packages/backend/scripts/build-lambdas.mjs): build-lambdas.mjs bundles the Lambda functions with esbuild to keep them small.
<!-- theory-links:end -->

### Trade-offs and pitfalls
- ✅ No servers to manage, automatic scaling, pay-per-use, fast to build. ❌ Cold starts, vendor lock-in, harder local development and debugging, limits, connection management, and cost at steady high volume.
- Pitfalls: Lambda calling Lambda synchronously (paying twice, error handling chains); no DLQ; non-idempotent handlers; VPC-attached Lambdas without VPC endpoints (NAT costs).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`handler`](../../packages/backend/apps/lambdas/src/handlers/media-processing.ts#L48): The media-processing handler is an SQS batch processor made idempotent. _(media-processing.ts)_
<!-- theory-links:end -->

### Theory
`08-DevOps-Cloud/03` (Lambda, RDS Proxy, IAM), `06-Distributed-Systems/01` (SQS, DLQ, idempotent consumers), `06-Distributed-Systems/02` (sagas, Step Functions), `08-DevOps-Cloud/02` (IaC).

---

## 4. Web app with a BFF and/or micro-frontends

**Prompt variants:** "We have web and mobile clients and 8 backend services. How do the clients talk to them?", "Five frontend teams work on one app. How do you structure it?"

### Clarify
- How many client types (web, iOS, Android, partner API) and how different are their needs?
- How many frontend teams, and do they need **independent deploys**?
- Is SEO / server rendering required?

### Design
```
Web (Next.js) ──► Web BFF (Next.js server / Node) ──┐
iOS/Android ───► Mobile BFF (NestJS/GraphQL) ───────┤──► domain services (users, orders, catalog, ...)
Partners ──────► Public API gateway ─────────────────┘
```
**BFF (Backend-for-Frontend):** one API layer per client type, owned by that client's team:
- aggregates calls to domain services (no chatty clients; see `04-API-Design/01` §2),
- shapes responses for its screens (mobile gets smaller payloads),
- holds the **session**: OAuth tokens stay server-side and the browser only has an HttpOnly session cookie (the recommended pattern for SPAs),
- handles client-specific concerns (feature flags, A/B variants, localization).

**Micro-frontends** (only when there are many teams):

| Approach | How | Trade-off |
|---|---|---|
| Route-level split (separate apps per path behind one domain: `/shop` → app A, `/account` → app B) | reverse proxy / Next.js multi-zones | simplest, fully independent; full page load between apps |
| Build-time composition (packages in a monorepo) | Nx/Turborepo, shared design system | one deploy, but strong consistency |
| Runtime composition | Module Federation, web components, iframes | independent deploys within one page; complexity, version skew, larger bundles |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`BffController`](../../packages/backend/libs/composition/bff/bff.controller.ts#L8): BffController aggregates product-page data for the web frontend. _(bff.controller.ts)_
> - [`BffModule`](../../packages/backend/libs/composition/bff/bff.module.ts#L42): BffModule configures GraphQL with cost limits, persisted queries and loaders, plus REST endpoints. _(bff.module.ts)_
> - [`StatelessPlatformModule`](../../packages/backend/libs/infrastructure/platform/platform.module.ts#L26): StatelessPlatformModule is the platform module used by the stateless BFF app. _(platform.module.ts)_ · [platform](../../docs/humans/concepts/platform-platform/platform.md)
<!-- theory-links:end -->

### Deep dives
- **Where aggregation lives**: in the BFF, with parallel downstream calls, per-call timeouts, and partial responses for optional widgets.
- **Avoid a "god BFF"**: business rules stay in the domain services; the BFF only composes and shapes.
- **Shared design system** (versioned component library) so micro-frontends look consistent. Shared dependencies (one React version) are negotiated through Module Federation `shared` config.
- **Auth**: one session cookie at the domain level, validated by the BFF, which calls services with service tokens or token exchange.
- **Next.js as a BFF**: Server Components and route handlers call internal services directly, so the browser gets rendered HTML or a minimal payload.

### Trade-offs and pitfalls
- A BFF adds a hop and a service to run. Worth it with 2+ client types or many services.
- Micro-frontends are an **organizational** solution. With one or two teams, a modular monolith frontend is faster and simpler.

### Theory
`04-API-Design/01` (chatty APIs, aggregation, GraphQL), `05-Security/02` §3 (BFF token storage), `09-Frontend-React-Next/03` (Next.js server components).

---

## 5. Content site / CMS (Jamstack, Next.js ISR)

**Prompt variants:** "Design a news site / blog / marketing site with a CMS", "Millions of product pages that rarely change", "Our Next.js build is very slow".

### Clarify
- How many pages, how often content changes, and how fast changes must go live (seconds vs minutes)?
- Personalization (logged-in content, A/B tests, geo)?
- Locales and SEO needs.
- Assumptions: 2M pages across 10 locales; editors publish ~1k changes/day and expect them live within a minute.

### Design
```
Editors ─► Headless CMS (Contentful/Strapi/Sanity, or own Postgres-backed admin)
                │ publish webhook (signed)
                ▼
           Revalidation endpoint ─► revalidateTag('article:123') / CDN purge by tag
Readers ─► CDN (cache HTML + assets) ─► Next.js (ISR / Cache Components) ─► CMS API / DB
```
- **Rendering mix**: popular pages pre-rendered at build; the long tail rendered on first request and cached (ISR / `generateStaticParams` for top pages only); personalized parts rendered client-side or streamed as dynamic "holes".
- **On-demand revalidation**: CMS publish webhook → invalidate exactly the affected tags/paths, instead of rebuilding the whole site.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`StoryCacheInvalidator`](../../packages/backend/libs/domains/content/infra/cache-invalidation.ts#L56): StoryCacheInvalidator invalidates the CDN and Next.js ISR on StoryPublished, which is the on-demand revalidation step. _(cache-invalidation.ts)_
> - [`CloudflarePurger`](../../packages/backend/libs/domains/content/infra/cache-invalidation.ts#L14): CloudflarePurger purges the CDN by tags in batches of 30. _(cache-invalidation.ts)_
> - [`CdnPurger`](../../packages/backend/libs/domains/content/infra/cache-invalidation.ts#L10): CdnPurger is the abstract port for purging the CDN by tags. _(cache-invalidation.ts)_
<!-- theory-links:end -->

### Deep dives
- **Build time**: never pre-render 20M page × locale combinations at build. Pre-render the top N, generate the rest on demand. Keep page payloads small: don't serialize whole translation dictionaries or CMS objects into client components.
- **Caching layers**: CDN cache (`s-maxage` + `stale-while-revalidate`), Next.js data/full-route caches, CMS API caching. Invalidation must reach all of them: tag-based purges at the CDN, and a **shared cache handler** (Redis/S3) when self-hosting multiple replicas.
- **i18n**: locale in the path (`/de/...`) for SEO and cacheability (not only cookie/`Accept-Language`, which fragments the cache), `hreflang` tags, per-locale sitemaps.
- **SEO**: server-rendered HTML, canonical URLs, structured data, sitemap index for millions of URLs, fast LCP (image optimization, font loading).
- **Preview mode** for editors (draft content, bypassing caches, behind auth).
- **Media**: images through an image CDN/optimizer with responsive sizes.

### Trade-offs and pitfalls
- Full static builds don't scale to millions of pages; fully dynamic rendering costs CPU and latency. ISR / on-demand generation is the middle ground, at the cost of cache-invalidation complexity.
- Pitfalls: per-replica ISR caches serving different versions; caching personalized HTML at the CDN (cookie in the cache key, or not caching at all); huge RSC payloads.

### Theory
`09-Frontend-React-Next/03` (rendering strategies, caching layers, self-hosting), `08-DevOps-Cloud/02` (CI build times), `03-Databases/04` (cache invalidation).

---

## 6. Offline-first PWA

**Prompt variants:** "Field workers fill in forms with no connectivity", "A notes/todo app that works offline and syncs", "Make our app installable and usable offline".

### Clarify
- What must work offline: reading only, or creating/editing too?
- Can several devices or users edit the same record (conflicts)?
- How much data per user must be available offline?

### Design
```
UI (React) ─► local DB (IndexedDB via Dexie / SQLite WASM + OPFS) ─► sync engine ─► Sync API ─► Postgres
                        ▲                                   │
                        └──── Service Worker: caches app shell & assets (Workbox), background sync
```
- **Service Worker** caches the app shell (HTML/JS/CSS) so the app loads offline; runtime caching strategies per resource (cache-first for static assets, network-first or stale-while-revalidate for API GETs).
- **Local database is the UI's source of truth**: the UI reads and writes locally (instant), and the sync engine replicates to the server in the background.
- **Outbox of local mutations**: each change is stored as an operation (`{ id: uuid, entity, op, payload, baseVersion }`) and pushed when online.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SyncService`](../../packages/backend/libs/domains/catalog-sync/application/sync.service.ts#L23): SyncService implements push/pull offline-first sync with HLC-based conflict resolution. _(sync.service.ts)_
> - [`SyncController`](../../packages/backend/libs/domains/catalog-sync/api/sync.controller.ts#L28): SyncController exposes the push, pull and conflicts endpoints. _(sync.controller.ts)_
<!-- theory-links:end -->

### Deep dives
- **IDs generated on the client** (UUIDv7), so records created offline don't need the server to assign IDs.
- **Sync protocol**: push = send pending operations (idempotent by operation ID); pull = "give me changes since cursor X" (a server-side change log with a monotonic sequence, not timestamps).
- **Conflict resolution**: last-writer-wins per **field** (with server-assigned versions), version checks with a conflict UI for important data, or **CRDTs** (Yjs/Automerge) for collaborative text. Pick per data type.
- **Background sync**: the Service Worker `sync` event retries when connectivity returns (Chromium); fallback: sync on app open/`online` event.
- **Storage limits and eviction**: request `navigator.storage.persist()`; Safari may evict data of sites not used for a while; don't treat local data as the only copy for long.
- **Auth offline**: tokens expire while offline; queue mutations and re-authenticate before pushing.
- **Schema migrations** of the local DB on app updates (versioned IndexedDB schema).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SyncService`](../../packages/backend/libs/domains/catalog-sync/application/sync.service.ts#L23): SyncService applies pushed operations and resolves conflicts with a hybrid logical clock instead of wall-clock timestamps. _(sync.service.ts)_
> - [`OpResult`](../../packages/backend/libs/domains/catalog-sync/application/sync.service.ts#L9): OpResult records the outcome of each pushed operation. _(sync.service.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Offline-first adds a distributed system to every client: sync, conflicts, migrations. Do it only when offline use is a real requirement; otherwise "offline-tolerant" (cache reads, queue a few writes) is enough.
- Pitfalls: timestamp-based sync (clock skew), server-generated IDs, no idempotency on push, Service Worker serving stale app versions forever (update flow: `skipWaiting` + prompt to reload).

### Theory
`01-JavaScript-TypeScript/01` §1.4 (Service Worker lifecycle, why no state in globals), `06-Distributed-Systems/02` (sync, conflicts, clocks), `04-API-Design/03` (idempotency).

---

## 7. Public API / developer platform

**Prompt variants:** "Expose our product to third-party developers", "Design Stripe's/Twilio's developer API".

### Clarify
- Who are the consumers (partners, the public), and what actions (read-only, payments, messaging)?
- Expected volume per customer, SLAs, and pricing per call?

### Design
```
Developer ─► Developer portal (docs, API keys, usage, webhook config, logs)
App ─► API gateway (auth: API keys / OAuth, rate limit, quotas, request logging)
         ─► versioned REST (or GraphQL) API ─► services
Events ─► webhook delivery platform (design 30) ─► developer endpoints
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PublicApiModule`](../../packages/backend/libs/domains/developer-platform/public-api.module.ts#L22): PublicApiModule assembles the developer-platform public API with auth, catalog and orders services. _(public-api.module.ts)_
> - [`PublicApiInterceptor`](../../packages/backend/libs/domains/developer-platform/api/public-api.interceptor.ts#L26): PublicApiInterceptor handles versioning, deprecation headers, request IDs and Kafka logging. _(public-api.interceptor.ts)_
> - [`WEBHOOK_QUEUE`](../../packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#L5): WEBHOOK_QUEUE names the SQS FIFO queue used for webhook delivery. _(webhook-events.ts)_
<!-- theory-links:end -->
### Deep dives
- **Authentication**: secret API keys for server-to-server (store **hashes** only; show the key once; prefixes like `sk_live_` for leak scanning; scoped and rotatable keys), publishable keys for client-side use (limited scope), OAuth 2 for apps acting on behalf of other users (marketplaces, integrations).
- **Rate limits and quotas**: per key and per endpoint, token bucket in Redis, `429` + `Retry-After` + `RateLimit` headers, plan-based quotas tracked for billing.
- **Idempotency keys** on all POSTs (`04-API-Design/03` §1), cursor pagination, consistent error format (Problem Details) with stable error codes.
- **Versioning**: date-based or `/v1` with a formal deprecation policy, `Deprecation`/`Sunset` headers, per-account pinned versions (`04-API-Design/02`).
- **Webhooks** for async events (signed, retried, replayable from the dashboard).
- **Developer experience**: OpenAPI spec as the source of truth → docs, SDKs (generated + hand-polished), sandbox/test mode with test keys and fake data, request logs in the dashboard, status page.
- **Observability per customer**: request logs searchable by request ID; usage dashboards.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`generateApiKey`](../../packages/backend/libs/domains/developer-platform/domain/api-key-format.ts#L27): generateApiKey creates the live/test key with a public prefix and a secret. _(api-key-format.ts)_
> - [`ApiKeyGuard`](../../packages/backend/libs/domains/developer-platform/api/api-key.guard.ts#L17): ApiKeyGuard validates the Bearer key, checks scopes and sets the tenant context. _(api-key.guard.ts)_
> - [`Domain_RateLimitedError`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.interceptor.ts#L11): Domain_RateLimitedError is thrown when a rate-limit policy is exceeded, returning HTTP 429 with retry guidance. _(rate-limit.interceptor.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Public APIs are effectively forever: every field you expose is a contract. Start smaller and stricter.
- Pitfalls: plaintext API keys in the DB, no idempotency on payments-like endpoints, breaking changes without versioning, offset pagination on huge collections.

### Theory
`04-API-Design/01–03`, `05-Security/02` (OAuth, API keys), `07-Observability-Reliability/01` (SLAs vs SLOs).
