# API Evolution, Versioning, and Formal Deprecation

> **Covers:** formal API deprecation: written policies, timelines and ownership.

The interviewer wants to hear a **process**, not just "add /v2": a written policy, a timeline with dates, telemetry-driven decisions, standard headers, named owners, and a defined end state.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PublicApiInterceptor`](../../packages/backend/libs/domains/developer-platform/api/public-api.interceptor.ts#L26): PublicApiInterceptor handles versioning and deprecation headers for the public API, the process-level implementation of this note. _(public-api.interceptor.ts)_
> - [`DEPRECATED_ROUTES`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L51): DEPRECATED_ROUTES records deprecated endpoints with their sunset dates and replacements. _(versioning.ts)_
<!-- theory-links:end -->

---

## 1. Avoid breaking changes in the first place

### Non-breaking (additive) changes
- Adding an optional request field, a response field, a new endpoint, or a new optional query parameter.
- Adding an enum value is **breaking for strict clients** that `switch` exhaustively. Document that clients must tolerate unknown values.

### Breaking changes
- Removing or renaming a field or endpoint, changing a type or format (`"12.30"` → `12.3`), making an optional field required, changing defaults, changing error codes or status codes, tightening validation, changing pagination semantics, changing auth requirements.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`VERSION_CHANGES`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L20): VERSION_CHANGES lists each breaking change between API versions together with a downgrade function. _(versioning.ts)_
<!-- theory-links:end -->

### Design for evolvability
- **Tolerant reader** (the robustness principle): clients ignore unknown fields, servers ignore unknown optional input (but validate everything they *use*).
- **Expand/contract for APIs**: add the new field, run both, migrate consumers, remove the old one, the same as DB migrations.
- Never expose DB schemas directly as API contracts. Map through DTOs so internal refactors don't leak out.
- **Contract tests** (Pact / consumer-driven contracts) show *exactly* which consumers depend on which fields, so you know whether a change is breaking for anyone.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`VERSION_CHANGES`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L20): Breaking changes are isolated as per-version downgrade transforms, so the latest shape stays the single implementation. _(versioning.ts)_
<!-- theory-links:end -->

---

## 2. Versioning strategies

| Strategy | Example | Pros | Cons |
|---|---|---|---|
| URI path | `/v1/invoices` | explicit, easy routing & caching, easy to see in logs | "version the world" for one change; URLs not stable |
| Header | `Api-Version: 2` | clean URLs | less visible, caching needs `Vary` |
| Media type | `Accept: application/vnd.acme.v2+json` | RESTful purist | awkward tooling |
| **Date-based (Stripe model)** | `Stripe-Version: 2024-06-20` | account **pinned** to version at signup; server applies **version transformation layers** to convert latest internal response to older shape; many small changes without big-bang v2 | complex to implement; must maintain transformations |
| GraphQL | no versions; `@deprecated(reason:)` fields; schema evolves | field-level usage analytics tell you who uses what | requires discipline |

**Senior recommendation:** use major versions (`/v1`, `/v2`) **rarely**, only for real paradigm changes. Evolve within a version through additive changes and per-field deprecation. Stripe-style date versioning suits public APIs with many integrators.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`API_VERSIONS`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L7): API_VERSIONS is the read-only tuple of supported date-based versions. _(versioning.ts)_
> - [`LATEST_VERSION`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L9): LATEST_VERSION is the current date-based version, '2026-10-01'. _(versioning.ts)_
> - [`isApiVersion`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L31): isApiVersion is a type guard that validates a requested version string. _(versioning.ts)_
<!-- theory-links:end -->

### Implementing multiple versions in Nest
```ts
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });  // or HEADER / MEDIA_TYPE
@Controller({ path: 'invoices', version: '2' })
```
Keep **one implementation** of the business logic and put version-specific **adapters/mappers** at the edge. Duplicated v1/v2 service logic will drift apart.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`transformForVersion`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L36): transformForVersion downgrades the latest-format response to an older pinned version at the edge, keeping one business logic implementation. _(versioning.ts)_
> - [`PublicApiInterceptor`](../../packages/backend/libs/domains/developer-platform/api/public-api.interceptor.ts#L26): PublicApiInterceptor applies the version transformation at the API boundary. _(public-api.interceptor.ts)_
<!-- theory-links:end -->

---

## 3. A formal deprecation policy (write it down and publish it)

Example policy text, the kind you'd put in an API handbook:

> 1. **Scope**: applies to all public and partner APIs. Internal APIs follow the same process with shortened windows.
> 2. **Minimum support windows** after deprecation announcement:
>    - Public API: **12 months** (major versions), **6 months** (individual endpoints/fields).
>    - Partner/enterprise contracts: as specified in contract SLA, minimum 6 months.
>    - Internal service APIs: **1–3 months**, or until all registered consumers have migrated.
>    - Security-driven removals may be expedited with direct notice (e.g., 30 days).
> 3. **Announcement channels**: changelog, developer portal, email to registered integrators' technical contacts, in-response headers, dashboard banners.
> 4. **Every deprecation includes**: reason, replacement, migration guide with examples, sunset date, contact/owner.
> 5. **Signals in responses**: `Deprecation` and `Sunset` headers and a `Link` to docs.
> 6. **No silent removal**: removal only after the sunset date **and** usage below the agreed threshold, or with explicit sign-off from the API owner + account management for remaining consumers.
> 7. **After sunset**: endpoint returns `410 Gone` with a Problem Details body pointing to the replacement for at least 3 months, then may return 404.

---

## 4. Standard HTTP headers

```http
HTTP/1.1 200 OK
Deprecation: @1767225599                                  # RFC 9745: structured date (Unix seconds) when it became/becomes deprecated
Sunset: Wed, 30 Sep 2027 23:59:59 GMT                     # RFC 8594: when it will stop working
Link: <https://developer.example.com/migrations/invoices-v2>; rel="deprecation"; type="text/html",
      <https://api.example.com/v2/invoices>; rel="successor-version"
```

- **`Deprecation`** (RFC 9745, 2025): the resource is or will be deprecated. Deprecated still means it **works**.
- **`Sunset`** (RFC 8594): the date after which it may stop responding.
- A Nest interceptor or middleware can attach them based on route metadata (`@Deprecated({ sunset: '2027-09-30', link })`), and should **log and emit a metric** for every call to a deprecated endpoint, labeled with the client ID.
- SDKs can surface these headers as runtime warnings.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PublicApiInterceptor`](../../packages/backend/libs/domains/developer-platform/api/public-api.interceptor.ts#L26): PublicApiInterceptor attaches the deprecation headers to responses. _(public-api.interceptor.ts)_
> - [`DEPRECATED_ROUTES`](../../packages/backend/libs/domains/developer-platform/domain/versioning.ts#L51): DEPRECATED_ROUTES supplies the sunset dates and replacements used for the Deprecation and Sunset headers. _(versioning.ts)_
<!-- theory-links:end -->

---

## 5. Timeline example (public endpoint removal)

| Date (T) | Phase | Actions | Owner |
|---|---|---|---|
| T-0 | **Decision** | RFC/ADR approved: why, replacement, impact analysis from usage data | API owner team (tech lead + product manager) |
| T+0 | **Announce / Deprecate** | Changelog + email + docs banner; `Deprecation` & `Sunset` headers on; replacement GA **before** announcing | API owner; DevRel/docs |
| T+0 → T+6m | **Migration support** | Migration guide, SDK release with new method, office hours; dashboard of usage per client | API owner; account managers for top consumers |
| T+6m | **Reminder** | Direct outreach to every client still calling it (from telemetry) | Account management + API owner |
| T+9m | **Brownouts** | Scheduled temporary failures (e.g., 1h, then 4h, then 24h) returning `410` with clear message, announced in advance; flushes out forgotten integrations | API owner + SRE/on-call aware |
| T+11m | **Final notice** | Last call to remaining clients | API owner |
| T+12m | **Sunset** | Endpoint returns `410 Gone` + Problem Details linking to migration guide | API owner |
| T+15m | **Removal** | Delete code, routes, docs, tests; close the ADR | API owner |

**Brownouts** (GitHub has used these, for example when deprecating password auth for Git operations) are the most effective way to find consumers that ignore emails and headers.

---

## 6. Ownership (RACI)

| Activity | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| Decide to deprecate | API owning team | Eng manager / product owner of the API | consumer teams, security, legal (for contracts) | all consumers |
| Provide replacement | API owning team | Eng manager | consumers (design review) | — |
| Communication | API team + DevRel | Product owner | customer success | consumers |
| Track migration | API team | Product owner | account managers | leadership if blocked |
| Removal | API team | Eng manager | SRE | consumers |

For **internal** APIs:
- Maintain a **consumer registry**: every service calling the API identifies itself (client ID in a service token, a `User-Agent`, or a mesh identity), so you know exactly who to talk to.
- The deprecating team **opens PRs/tickets** for consumer teams, or migrates them directly in a monorepo. "Whoever breaks it, fixes it" or "provider assists migration" should be an explicit org rule.
- Track it like a project: Jira epic, burndown of remaining consumers, an exit criterion of 0 calls for 14 days.

---

## 7. Telemetry: make decisions from data

- Metric: `api_deprecated_calls_total{endpoint, client_id, version}`.
- Dashboard: calls per client over time, and the last call date per client.
- Exit criteria: "**fewer than X calls/day, from no paying customer, for 30 consecutive days**", or explicit sign-off.
- For GraphQL: field-level usage analytics (Apollo Studio, GraphQL Hive) show which operations still use deprecated fields.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ApiRequestLogged`](../../packages/backend/libs/domains/developer-platform/application/events/api-events.ts#L5): ApiRequestLogged is the event schema for public API request logging with request and shop metadata, which provides per-client usage data. _(api-events.ts)_
<!-- theory-links:end -->

---

## 8. Webhooks and events need versioning too

- Version the event payload (`"type": "invoice.paid", "apiVersion": "2026-01-01"`), or deliver according to the endpoint's pinned version.
- Event schemas: a schema registry with backward compatibility checks, so consumers keep working when producers add fields.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`WebhookEndpoint`](../../packages/web/lib/api/developers.ts#L34): WebhookEndpoint carries a version field, so each webhook endpoint is pinned to an API version. _(developers.ts)_
> - [`WEBHOOK_EVENT_TYPES`](../../packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#L2): WEBHOOK_EVENT_TYPES is the allowed list of versioned webhook event types. _(webhook-events.ts)_
> - [`WebhookRouterProjector`](../../packages/backend/libs/domains/developer-platform/infra/webhook-router.projector.ts#L34): WebhookRouterProjector converts domain events into per-shop webhook deliveries queued to SQS. _(webhook-router.projector.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How would you deprecate an endpoint that partners use?**
Ship and stabilize the replacement first. Publish a deprecation notice under a written policy (for example a 6–12 month window) with a migration guide. Add `Deprecation`, `Sunset`, and `Link` headers to responses. Instrument calls per client so I know exactly who's still on it. Contact the remaining clients directly, run announced brownouts closer to the date, return `410 Gone` with a pointer to the replacement after sunset, and remove the code later. The API-owning team runs it, with product accountable and account managers looped in for external partners.

**Q: URI versioning vs header versioning?**
URI is explicit and cache/log friendly, and it's what most teams use for major versions. Headers keep URLs stable. More important than the mechanism: version rarely, evolve additively, and keep version-specific mapping at the edges with one core implementation.

**Q: Is adding a field breaking?**
Usually not, if clients are tolerant readers. Adding an **enum value** or a **required** input field is breaking. Changing a type or format is breaking even when the name stays the same.
