---
id: bff-aggregate
title: The BFF and page aggregates
kind: concept
status: draft
defined_by: S48
---
# The BFF and page aggregates
## Definition
The BFF (backend for frontend) is the single entry point for web and native clients. It assembles page aggregates, such as the product page, from domain APIs called over HTTP within fixed time budgets. It answers GraphQL queries and manages browser sessions, and it owns no database table. Browsers never hold a token. Each aggregate degrades per section: only the required section can fail the page, and an optional section becomes `null` with an `errors` entry.

## Rules
- **bff-aggregate.C-01** The page response MUST carry [`Cache-Control: private, no-store` ↗](../sw-external-terms.md#cache-control) and a [`Server-Timing` ↗](../sw-external-terms.md#server-timing) header with one entry per [section](../terms/section.md).
- **bff-aggregate.C-02** Only the product section is [required](../terms/required-section.md). A failed optional section MUST be `null` with one [`errors` entry](../terms/errors-entry.md) `{section, code, retryable}`. A section that does not apply MUST be `null` with no error and no [upstream call](../terms/upstream.md).
- **bff-aggregate.C-03** The [page deadline](../terms/page-deadline.md) is 1,000 ms. A [dependent section](../terms/dependent-section.md) gets only the time left. A section past the deadline MUST be `null` with [`BUDGET_EXCEEDED`](../terms/page-deadline.md).
- **bff-aggregate.C-04** After 5 consecutive failures within 10 s, an [optional upstream](../terms/upstream.md)'s [breaker ↗](../sw-external-terms.md#circuit-breaker) MUST open for 10 s. Its section is `null` with `CIRCUIT_OPEN`.
- **bff-aggregate.C-05** The [BFF ↗](../sw-external-terms.md#bff) MUST NOT forward [`X-User-Id`](../terms/identity-headers.md), `X-User-Role`, `X-Tenant-Id`, `X-Shop-Id`, `Cookie` or an invalid [`X-Anonymous-Id`](../terms/x-anonymous-id.md) to any upstream. A token MUST go only to the configured [domain-API origin](../terms/domain-api-origin.md).
- **bff-aggregate.C-06** A request carrying both a [session cookie](../terms/session-cookie.md) and an `Authorization` header MUST give [`400 ambiguous_credentials`](../terms/ambiguous-credentials.md). A cookie-authenticated POST MUST carry an [`X-CSRF-Token` ↗](../sw-external-terms.md#csrf-token) equal to the [`__Host-bff-csrf`](../terms/csrf-token.md) cookie, or the BFF answers `403 csrf_invalid`.
- **bff-aggregate.C-07** A [GraphQL query deeper than 6 levels or costing more than 2,000](../terms/graphql-query-limits.md) MUST be rejected before any upstream call. Each loader batch call MUST carry at most 100 IDs.
- **bff-aggregate.C-08** A cookie-bearing request MUST give [`503 session_unavailable`](../terms/session-store.md) when the session store is down. An [anonymous request](../terms/x-anonymous-id.md) MUST be served normally.

## How the capabilities use it
- {{cap:S48}} defines it: the product-page aggregate with budgets, per-section partial errors, GraphQL, CSRF checks and single-flight token refresh.
- {{cap:W01}} relies on it to hold the signed-in state in an opaque HttpOnly session cookie and a readable CSRF cookie, never a token.
- {{cap:W02}} turns the S48 product-page aggregate into screens.
- {{cap:W03}} reads the cart and order page aggregates from it.
- {{cap:S35}} lists the concept, but its facts contain no line that links it.

## Known gaps
- The facts describe only the product-page aggregate in detail. The cart and order page aggregates used by W03 have no rules here.
- S35 and W02 list the concept, but no line explains what they rely on, beyond W02 using the S48 product-page aggregate.

## Used by
<!-- used-by:start -->
- {{cap:S35}} Trending products: windowed approximate top-K per category
- {{cap:S48}} BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
- {{cap:W01}} Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
<!-- used-by:end -->
