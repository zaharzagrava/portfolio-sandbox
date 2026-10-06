# Next.js Architecture (App Router, RSC, Caching, Rendering, Self-hosting)

> Versions move fast. As of late 2025 / 2026: **Next 15** made `fetch` uncached by default and request APIs (`cookies()`, `headers()`, `params`) async. **Next 16** stabilized **Cache Components** (`'use cache'`), made **Turbopack** the default bundler, and renamed `middleware.ts` → **`proxy.ts`**. Check which version the company uses and frame answers around the concepts.

---

## 1. Rendering strategies

| Strategy | When HTML is generated | Use for |
|---|---|---|
| **SSG** (static) | at build time | marketing pages, docs |
| **ISR** (incremental static regeneration) | static, re-generated in background after `revalidate` seconds or on-demand (`revalidatePath`/`revalidateTag`) | product pages, content with occasional updates |
| **SSR / dynamic** | per request | personalized, request-dependent (cookies, headers) |
| **Streaming SSR** | per request, sent progressively with Suspense boundaries | slow data parts don't block the shell |
| **PPR / Cache Components** | static shell prerendered + dynamic holes streamed per request | mix static & personalized on the same page |
| **CSR** | in browser | highly interactive, behind auth, SEO irrelevant |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductLoading`](../../packages/web/app/products/%5Bslug%5D/loading.tsx#L3): The product page's loading.tsx renders skeleton placeholders while the page streams in. _(loading.tsx)_
> - [`DashboardLayout`](../../packages/web/app/dashboard/layout.tsx#L8): DashboardLayout wraps its content in Suspense so the shell streams first. _(layout.tsx)_
<!-- theory-links:end -->

---

## 2. React Server Components (RSC)

- **Server Components** (the default in `app/`) run **only on the server**. Their code **never ships to the browser**. They can be `async` and access the DB or secrets directly. They can't use state, effects, or browser APIs.
- **Client Components** (`'use client'` at the top of a file) are rendered on the server for the HTML **and** hydrated in the browser. They can use hooks and events.
- `'use client'` marks a **boundary**: everything imported *into* a client component becomes client code. Keep the boundaries **as low (leaf-ward) as possible**.
- Server → Client props must be **serializable** (no functions, except Server Actions; no class instances). Dates, Maps, Sets, and promises are supported by the RSC protocol.
- You *can* pass Server Components as `children` to Client Components (composition), which keeps them server-rendered.
- **RSC payload**: a serialized description of the rendered tree, sent to the client for navigation and reconciliation. **Large props passed to client components get embedded in that payload, in the HTML (for hydration), and duplicated across pages.**

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SearchPage`](../../packages/web/app/search/page.tsx#L402): The search page is a Suspense-wrapped page that composes client-side filters and autocomplete. _(page.tsx)_
> - [`serverApiUrl`](../../packages/web/lib/api/catalog.ts#L85): serverApiUrl gives server-side code the core API base URL so server components can fetch directly. _(catalog.ts)_
<!-- theory-links:end -->

### Example: oversized translation payloads
- Problem: passing **full translation dictionaries** (all namespaces, sometimes all locales) into a client provider means every page's HTML and RSC payload carries hundreds of KB of strings → huge HTML, slow builds (serializing and writing the payload for every prerendered page × locale), slow TTFB.
- Fix: translate **in Server Components** (strings resolved on the server, only rendered text is sent); for client components, pass **only the namespaces/keys they need**; load messages per locale and route; avoid prerendering every locale × page at build if traffic doesn't justify it (generate on demand with ISR).
- Results: much smaller HTML, a much faster build, and better LCP/TTFB.

---

## 3. Data fetching and caching layers

Next.js (App Router) has several caches. Knowing them separates seniors from everyone else:

| Cache | What | Where | Duration | Opt-out / invalidate |
|---|---|---|---|---|
| **Request memoization** | dedupe identical `fetch` calls during one render pass | server, per request | request | automatic (use `React.cache()` for non-fetch functions like DB calls) |
| **Data Cache** | results of `fetch` (when opted in) | server, persistent across requests & deploys | until revalidated | `fetch(url, { next: { revalidate: 60, tags: ['invoices'] } })`, `revalidateTag('invoices')`, `cache: 'no-store'` |
| **Full Route Cache** | rendered HTML + RSC payload of static routes | server | until revalidation / redeploy | dynamic APIs (`cookies()`, `headers()`), `export const dynamic = 'force-dynamic'`, `revalidate` |
| **Router Cache** | RSC payloads of visited/prefetched routes | browser memory | session / short time | `router.refresh()`, `revalidatePath` from server action |

- Next 15+: `fetch` is **not cached by default**. Opt in explicitly.
- Next 16 **Cache Components**: the `'use cache'` directive on functions, components, or pages, with `cacheLife()` and `cacheTag()`, which makes caching explicit and composable.
- `unstable_cache` / `React.cache` for non-fetch data sources (ORM calls).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`StoryCacheInvalidator`](../../packages/backend/libs/domains/content/infra/cache-invalidation.ts#L56): StoryCacheInvalidator is a projector that invalidates the CDN and the Next.js ISR cache when a StoryPublished event arrives. _(cache-invalidation.ts)_
> - [`CacheService`](../../packages/backend/libs/infrastructure/cache/cache.service.ts#L48): CacheService is a multi-level cache (in-process LRU plus Redis) with stampede prevention, a backend counterpart to layered caching. _(cache.service.ts)_
<!-- theory-links:end -->

---

## 4. Server Actions

```tsx
// app/invoices/actions.ts
'use server';
export async function approveInvoice(formData: FormData) {
  const session = await auth();                               // ALWAYS authenticate
  const id = z.string().uuid().parse(formData.get('id'));     // ALWAYS validate
  await assertCanApprove(session.user, id);                   // ALWAYS authorize (record-level)
  await db.invoice.update({ where: { id }, data: { status: 'approved' } });
  revalidateTag('invoices');
}
```
- They're **public HTTP POST endpoints** with generated IDs. Anyone can call them with arbitrary input, so treat each one like an API route: authentication, authorization, validation, rate limiting.
- CSRF: Next compares `Origin` with `Host` for Server Actions, and they're POST-only. Configure `serverActions.allowedOrigins` behind proxies.
- They work with progressive enhancement (forms submit without JS), `useActionState`, `useOptimistic`.
- Closures over server variables are encrypted when sent to the client. Still, don't close over secrets.

---

## 5. Middleware / proxy and auth

- Runs before routing, for every matched request (historically on the Edge runtime; Node runtime support was added later). Use it for redirects, rewrites, locale detection, A/B bucketing (setting a cookie), and **cheap** auth checks (is there a session cookie?).
- **Don't rely only on middleware for authorization**: **CVE-2025-29927** (March 2025) let attackers **skip middleware entirely** with a crafted `x-middleware-subrequest` header on self-hosted Next versions. Lesson: **do authorization at the data access layer** (in server components, actions, and route handlers), defense in depth. It's a good story to bring up in a security discussion.
- A/B testing: assign the variant in middleware/proxy (deterministic hash of user ID → cookie), and rewrite to the variant page so it can still be statically cached per variant.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LoadSheddingMiddleware`](../../packages/backend/libs/common/load-shedding/load-shedding.middleware.ts#L15): LoadSheddingMiddleware is backend middleware that rejects requests with 503 when event-loop lag is too high. _(load-shedding.middleware.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
<!-- theory-links:end -->

---

## 6. Performance features

- `next/image`: responsive `srcset`, lazy loading, modern formats, prevents CLS through width/height. Self-hosted, it needs `sharp` and CPU, so consider a CDN image service.
- `next/font`: self-hosted fonts, no layout shift, no external requests.
- `next/script` strategies: `beforeInteractive`, `afterInteractive`, `lazyOnload`, `worker`.
- Route prefetching through `<Link>`. Streaming with `loading.tsx` and Suspense.
- Bundle analysis, `optimizePackageImports` for barrel-file libraries.

---

## 7. Self-hosting Next.js on Kubernetes

- `output: 'standalone'` for a minimal image (see the Docker doc).
- **Multiple replicas + ISR/Data Cache**: the default cache lives on **each pod's filesystem**, so pods serve different versions and revalidation only hits one pod. Configure a **shared cache handler** (`cacheHandler` → Redis/S3), or let the CDN cache with proper headers.
- Set `deploymentId` / build ID consistency across pods, so client navigations don't break mid-deploy (version skew). Keep old static assets available for a while (CDN or bucket).
- **Server Actions encryption key** (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`) must be the same across all replicas and builds.
- Health endpoints (route handlers), graceful shutdown, resource limits (SSR is CPU-heavy, so set the HPA on CPU).
- Put a CDN in front (Cloudflare, CloudFront) for static assets (`/_next/static/*`, immutable, long max-age) and cacheable pages.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`web/next.config.ts`](../../packages/web/next.config.ts): next.config.ts configures the web app's API proxying, image handling, redirects and security headers for deployment.
> - [`StoryCacheInvalidator`](../../packages/backend/libs/domains/content/infra/cache-invalidation.ts#L56): Cache invalidation purges the CDN and Next.js ISR on publish, so the cache is not tied to a single pod. _(cache-invalidation.ts)_
> - [health](../../docs/humans/concepts/platform-health/health.md): The platform health module provides liveness and readiness endpoints for Kubernetes and the ALB.
<!-- theory-links:end -->

---

## 8. Pages Router vs App Router (in case of a legacy codebase)
- Pages: `getServerSideProps`, `getStaticProps`, `getStaticPaths`, `_app`, `_document`, API routes in `pages/api`. Everything is a client component (hydrated).
- App: layouts (nested, persistent), RSC, Server Actions, streaming, colocated loading and error UI, route handlers (`route.ts`).
- Migration is incremental: both can live side by side.

---

## Interview Q&A

**Q: What's the benefit of Server Components?**
Zero client JS for non-interactive parts, direct server-side data access (no API round trip, secrets stay on the server), smaller bundles, and streaming. Interactive parts stay small client islands. Trade-offs: the serialization boundary, a new mental model, and the caching complexity.

**Q: How do you invalidate a page after a mutation?**
From a Server Action or route handler, call `revalidateTag` (tag-based fetch or cache entries) or `revalidatePath`. In multi-replica self-hosting, make sure a shared cache handler exists so all pods see the invalidation.

**Q: A Next.js build is very slow and pages are huge. What would you check?**
What gets serialized into each page: a common cause is passing whole translation dictionaries (or large CMS objects) into client components, which bloats every page's HTML/RSC payload and makes pre-rendering expensive. Resolve translations on the server, send only the needed namespaces to client components, and don't pre-render locale × page combinations that traffic doesn't justify (generate them on demand).
