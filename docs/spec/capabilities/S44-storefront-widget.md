---
id: S44
title: Embeddable storefront widget: site keys bound to origins, per-site framing policy, identity hand-off, kill switch
kind: capability
status: draft
generated_at: 1c054773
depends_on: [S54, S01, S03, S05, S50, S52, S53]
concepts: [problem-json-errors, rate-limit-policy, tenant-shop-rbac, request-context, outbox-task-queue, projection-and-replay, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/developer-platform/**
  - packages/contracts/src/developer-platform/**
  - packages/edge-be/src/widget-loader.ts
---
# S44 - Embeddable storefront widget

## Purpose
A shop puts a "Buy on Marketplace" button on its own website with one script tag that carries a public site key. A visitor clicks it and our checkout opens in an iframe over the shop's page. The key is public, so it is bound to a short list of exact origins; only those pages get the shop's configuration and only those pages may frame the checkout. The shop's own server can say who its customer is with a short-lived single-use signed token, and a kill switch stops everything at once. See {{concept:tenant-shop-rbac}} for who may manage sites and {{concept:problem-json-errors}} for the error shape.

## Entry points
- Dashboard routes under `/api/shops/:shopId/widget/sites` create, list, read, update, rotate the identity secret of, expire the previous secret of, delete, switch off and on, and read the history of sites. [code: packages/backend/libs/domains/developer-platform/api/widget-sites.controller.ts#WidgetSitesController]
- Public routes under `/api/widget/v1`: `GET config`, `POST identify`, `GET session`, `GET embed` and the preflight of the first three. [code: packages/backend/libs/domains/developer-platform/api/widget.controller.ts#WidgetController]
- The loader script, served by the edge at the address `/widget/v1/loader.js`. [code: packages/edge-be/src/widget-loader.ts]
- The consumers of `tenancy.shop_updated`, `tenancy.shop_status_changed` and `tenancy.shop_deleted`. [code: packages/backend/libs/domains/developer-platform/widget-projector.module.ts#WidgetProjectorModule]
- `WidgetSessionService.verify(token, origin?)` for other domains. [code: packages/backend/libs/domains/developer-platform/application/widget-session.service.ts#WidgetSessionService]
- Configuration keys: `widget_token_key` (required, at least 32 bytes), `WIDGET_APP_BUNDLE_URL` (default `/widget/v1/app.js`; an absolute value must be HTTPS) and `WIDGET_CHECKOUT_URL` (HTTPS).

## Rules
- **S44.R-01** Only a member with `widget.manage` (OWNER, ADMIN) MUST use the dashboard routes; STAFF and VIEWER get `403 permission_denied`, a non-member `404 shop_not_found`, an anonymous caller `401`, and every site lookup MUST carry the shop so an unknown id and another shop's id give the same `404 widget_site_not_found`. [proof: S44 AS-09]
- **S44.R-02** A site MUST have a name of 1 to 60 characters, 1 to 10 origins, 0 to 12 featured products, a theme, a kill switch, a version and an immutable key `pk_live_` plus 24 URL-safe characters; unknown properties MUST be refused. [proof: S44 AS-01, S44 AS-03]
- **S44.R-03** An origin MUST be a bare `https` origin, lower-cased and converted to ASCII, with the default port removed, at least two labels, no wildcard, IP literal, `localhost`, trailing dot, user info, path, query or fragment; a rejection MUST be `422 origin_invalid` with a reason from a closed list. [proof: S44 AS-02] [code: packages/backend/libs/domains/developer-platform/domain/origin.ts#normalizeOrigin]
- **S44.R-04** A shop MUST NOT hold more than 10 sites, enforced by the store so concurrent creations cannot exceed it. [proof: S44 AS-05]
- **S44.R-05** An update MUST carry `expectedVersion`; of two concurrent updates exactly one wins and the other answers `409 site_version_conflict`. [proof: S44 AS-07]
- **S44.R-06** Featured products MUST be checked in one batch through the catalog with the shop filter; a foreign or unknown product MUST give the same `422 featured_product_invalid`. [proof: S44 AS-08]
- **S44.R-07** The theme MUST accept only the allowed keys with the allowed value formats. [proof: S44 AS-04] [code: packages/backend/libs/domains/developer-platform/domain/theme.ts#validateTheme]
- **S44.R-08** The identity secret MUST be shown once, in the create and rotate responses, and stored only sealed with the context `widget-site:<siteId>`. [proof: S44 AS-01, S44 AS-10]
- **S44.R-09** A site MUST hold at most a current and a previous secret; the previous one stays valid until its expiry decided by the clock at the moment of use; a rotation while it is valid MUST answer `409 rotation_in_progress`. [proof: S44 AS-10, S44 AS-11, S44 AS-28]
- **S44.R-10** Deleting a site MUST remove it and its history and apply on every instance at the next request. [proof: S44 AS-12]
- **S44.R-11** A dashboard mutation authenticated by a cookie MUST pass the platform CSRF check; a bearer call needs none. [proof: S44 AS-13]
- **S44.R-12** The public routes MUST resolve the key, then check the origin, then the switch and the shop status, before other work; a malformed or unknown key MUST give the same `404 widget_site_not_found` and a malformed key MUST never become a cache key. [proof: S44 AS-16, S44 AS-17, S44 AS-30]
- **S44.R-13** Origin matching MUST be whole-origin equality after normalisation, never by prefix, suffix or substring. [proof: S44 AS-15] [code: packages/backend/libs/domains/developer-platform/domain/origin.ts#matchOrigin]
- **S44.R-14** Cross-origin access MUST be granted per site: the registered origin is echoed with `Vary: Origin`, credentials are never allowed, the preflight answers only registered origins and the application-wide CORS policy does not apply. [proof: S44 AS-14, S44 AS-18]
- **S44.R-15** `config` MUST return integer minor-unit prices for the live, non-archived products of the site's shop in the configured order, read from the catalog in one batch, the shop name from the site's copy, and nothing private. [proof: S44 AS-14, S44 AS-19]
- **S44.R-16** A change of a site MUST be visible on the next request on every instance; no per-process copy of a site record may outlive a change. [proof: S44 AS-20]
- **S44.R-17** When the product lookup fails `config` MUST serve the last good response for up to 600 seconds, otherwise `503 service_unavailable`, and a failure MUST NOT be cached as success. [proof: S44 AS-21]
- **S44.R-18** Public routes MUST be limited by `widget.config.ip` (fail-open), `widget.identify.ip` and `widget.identify.site` (fail-closed) and never spend the login policies. [proof: S44 AS-22]
- **S44.R-19** A hand-off token MUST be HS256 with the claims policy of the spec (audience, issuer, `sub`, `jti`, lifetime at most 300 seconds, clock skew limits, well-formed e-mail); every rejection MUST be the same `401 identity_token_invalid`. [proof: S44 AS-24, S44 AS-25] [code: packages/backend/libs/domains/developer-platform/domain/handoff-claims.ts#evaluateHandoffClaims]
- **S44.R-20** A hand-off token MUST be single use per site by one atomic set-if-absent that expires at the token's `exp` plus 60 seconds; an unreachable store MUST answer `503` without consuming the token. [proof: S44 AS-26, S44 AS-27]
- **S44.R-21** A successful exchange MUST mint a 900 second widget token signed with a dedicated key, with `typ: widget+jwt` and `aud: marketplace-widget-session`, refused by every other verifier and refusing theirs. [proof: S44 AS-23, S44 AS-33]
- **S44.R-22** A customer claim MUST NOT create, link or change any marketplace user, session or account. [proof: S44 AS-29]
- **S44.R-23** `identify` MUST accept only `application/json` up to 8 KiB, read and set no cookie. [proof: S44 AS-31]
- **S44.R-24** `GET session` and `WidgetSessionService.verify` MUST take the same decision: signature, type, audience, expiry, site present, switch off, shop active and origin still registered. [proof: S44 AS-32]
- **S44.R-25** The embed document MUST be the only response that allows framing, by exactly the site's sorted origins; every other response MUST carry `frame-ancestors 'none'`. [proof: S44 AS-35, S44 AS-36] [code: packages/backend/libs/domains/developer-platform/domain/frame-policy.ts#buildFrameAncestors]
- **S44.R-26** The embed document MUST carry a fresh nonce of at least 128 bits per response and a script policy limited to that nonce and `strict-dynamic`, with `default-src 'none'`, `object-src 'none'`, `base-uri 'none'` and `form-action 'self'`, one nonced script, `Cache-Control: no-store` and no `X-Frame-Options`; the bundle address comes from `WIDGET_APP_BUNDLE_URL`. [proof: S44 AS-34, S44 AS-38] [code: packages/backend/libs/domains/developer-platform/domain/frame-policy.ts#buildEmbedCsp]
- **S44.R-27** Embed refusals MUST be problem documents, never reflect the submitted key, and a malformed key MUST be refused before reflection. [proof: S44 AS-37]
- **S44.R-28** The kill switch MUST be idempotent and race-safe: only a real change writes one history row and one event in the same transaction, and it MUST stop `config`, `identify`, `session`, `embed` and issued tokens on the next request on every instance. [proof: S44 AS-39, S44 AS-40, S44 AS-41]
- **S44.R-29** A shop that is not `ACTIVE` MUST make its sites answer `410 widget_disabled` without touching their switches, with a version guard that ignores older and duplicate events. [proof: S44 AS-42, S44 AS-43] [code: packages/backend/libs/domains/developer-platform/domain/shop-copy.ts#decideShopCopy]
- **S44.R-30** A deleted shop MUST lose all its sites and history, one `deleted` event per site, idempotently. [proof: S44 AS-44]
- **S44.R-31** Every consumer MUST validate its payload, dead-letter an invalid one without effect and give a repeated one a single effect. [proof: S44 AS-45]
- **S44.R-32** A site MUST be created with the shop's name, status and version read once through the tenancy query service outside the transaction. [proof: S44 AS-46]
- **S44.R-33** The loader MUST be small, define one global first, use no unsafe sink or wildcard target, send no credentials, accept only checked messages from its iframe, and render nothing on any failure. [proof: S44 AS-47, S44 AS-48, S44 AS-49]
- **S44.R-34** Every site change MUST write exactly one `developerplatform.widget_site_changed` event in the transaction of the change and none for a no-op. [proof: S44 AS-51]
- **S44.R-35** No secret, token, key or customer e-mail MUST appear in a log, metric label, event or error body. [proof: S44 AS-52]
- **S44.R-36** Every error MUST be a problem document with a code from the closed list and every body MUST parse with its contract schema. [proof: S44 AS-53]
- **S44.R-37** The shop copy on a site MUST be at most 60 seconds behind the shop (p99). [proof: none]

## Behaviors
- **S44.B-01** Given an admin of an active shop, when they create a site with two origins, then the secret is in the response once, the stored secret is sealed and a later read shows none. [proof: S44 AS-01]
- **S44.B-02** Given a key copied to another website, when that page asks for the configuration, then it gets `403 origin_not_allowed` and no shop data. [proof: S44 AS-16]
- **S44.B-03** Given 1,000 simultaneous exchanges of one hand-off token, when they run, then exactly one succeeds. [proof: S44 AS-26]
- **S44.B-04** Given a site registered for two origins, when its embed document is fetched, then the framing policy lists exactly those origins sorted. [proof: S44 AS-35]
- **S44.B-05** Given a warm cache on two instances, when a manager switches the site off, then the very next call on either instance answers `410`. [proof: S44 AS-39]
- **S44.B-06** Given a suspended shop, when its widget is used, then it answers `410` and works again when the shop is active. [proof: S44 AS-43]
- **S44.B-07** Given a previous secret with a 24 hour overlap, when 24 hours pass, then tokens signed with it are refused. [proof: S44 AS-28]

## Lifecycles
- Kill switch: `false` and `true`, changed only by `PUT kill-switch`; the same value changes nothing. The effective state also requires the shop to be `ACTIVE`.
- Secret: one current; after a rotation a previous one until its expiry or `expire-previous-secret`.
- Shop copy: version-guarded; a greater version applies, an equal or lower one is ignored.

## Owns
- Tables `WidgetSite` and `WidgetSiteChange`; no foreign key to another owner's table.
- Event `developerplatform.widget_site_changed`.
- Policies `widget.config.ip`, `widget.identify.ip`, `widget.identify.site`, `widget.manage.shop`.
- Redis keys `widget:site:*`, `widget:unknown:*`, `widget:config:*`, `widget:jti:*`.

## Decisions
- Origin binding is a browser-side control: the public key unlocks only public data, everything privileged needs the identity secret.
- Shop name and status are a copy on the site fed by events, so the hottest public route never reads the tenancy tables.
- The widget token has its own key and type so no other verifier accepts it.
- No cookie is used anywhere on the widget routes; the token lives in the iframe's memory.

## Known gaps
- Edge-cache behaviour at scale (50,000 requests per second), the real-browser framing matrix, the usability goal and the shop-copy lag percentile have no automated proof; see `specs/UNVERIFIED.md`.
- The permission `widget.manage` was added to the tenancy matrix by this capability; S03 owns it from now on.
