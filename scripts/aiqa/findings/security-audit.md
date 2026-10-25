# Security: dependency audit (pnpm audit --prod)

Run 2026-10-25 07:34. Known holes in the packages the web app and the API ship with. `pnpm audit` checks the whole lock file, so the list is split by which package pulls the dependency in.

## packages/web: 35 advisories (critical 3, high 13, moderate 13, low 6)

- CRITICAL `next` 16.3.8 (fixed in >=16.4.1): Next.js: Unauthenticated Remote Code Execution in Image Optimization API when SVG files are used https://github.com/advisories/GHSA-2464-fhr4-w9xw
- CRITICAL `next` 16.3.8 (fixed in >=16.4.1): Next.js: Unauthenticated Remote Code Execution in `use cache` functions returning typed arrays https://github.com/advisories/GHSA-673q-mjm6-r5xr
- CRITICAL `dompurify` 3.4.16 (fixed in >=3.4.17): DOMPurify SAFE_FOR_TEMPLATES bypass: split template expressions survive in attached shadow root content on DOM output modes https://github.com/advisories/GHSA-cg2g-xh64-v4q7
- HIGH `undici` 7.29.0 (fixed in >=7.29.1): undici vulnerable to Denial of Service via unrequested WebSocket subprotocol https://github.com/advisories/GHSA-rfgv-xxqx-mfg5
- HIGH `undici` 7.29.0 (fixed in >=7.29.1): undici vulnerable to TLS certificate validation bypass via dropped connect options in BalancedPool https://github.com/advisories/GHSA-w293-vg96-wgc3
- HIGH `source-map-js` 1.2.1 (fixed in >=1.2.2): source-map-js allows event-loop denial of service through indexed source-map section offsets https://github.com/advisories/GHSA-68fv-2mgg-jv7q
- HIGH `sharp` 0.35.4 (fixed in >=0.35.5): sharp : Vulnerability in librsvg dependency CVE-2026-96889 https://github.com/advisories/GHSA-wq5f-xc86-pv6w
- HIGH `follow-redirects` 1.16.0 (fixed in >=1.16.1): follow-redirects array-form headers bypass cross-origin credential stripping https://github.com/advisories/GHSA-q3jh-wrc6-jgq8
- HIGH `follow-redirects` 1.16.0 (fixed in >=1.16.1): follow-redirects sensitiveHeaders regex escaping can expose credential headers https://github.com/advisories/GHSA-8r9p-f939-6h3c
- HIGH `@modelcontextprotocol/sdk` 1.31.0 (fixed in >=1.32.0): MCP TypeScript SDK: Experimental tasks were not tied to the session that created them https://github.com/advisories/GHSA-22jm-h49p-29qw
- HIGH `@modelcontextprotocol/sdk` 1.31.0 (fixed in >=1.32.0): MCP TypeScript SDK: One HTTP request within the default size limit could exhaust server memory during validation https://github.com/advisories/GHSA-46jr-4wx8-v453
- HIGH `next` 16.3.8 (fixed in >=16.4.1): Next.js: Denial of Service in App Router using Server Actions https://github.com/advisories/GHSA-p3m5-59mp-jv5r
- HIGH `dompurify` 3.4.16 (fixed in >=3.4.17): DOMPurify IN_PLACE: hook that removes a parent or sibling leaves the detached subtree's event handlers armed (incomplete fix for GHSA-p98j-92pf-mc4p) https://github.com/advisories/GHSA-mrv2-3pqr-j5jr
- HIGH `zod` 3.25.76 (fixed in >=4.6.6): Zod can exhaust memory while validating oversized constrained collections https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- HIGH `body-parser` 2.3.0 (fixed in >=2.4.0): body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body https://github.com/advisories/GHSA-27r3-jxmh-p828
- HIGH `undici` 7.29.0 (fixed in >=7.30.1): undici vulnerable to Denial of Service via unhandled error on excessive content-encodings https://github.com/advisories/GHSA-xjj6-f33q-929c

(moderate and low: undici, postcss-selector-parser, @modelcontextprotocol/sdk, ip-address, fast-uri, dompurify)

## packages/backend: 52 advisories (critical 0, high 20, moderate 29, low 3)

- HIGH `@opentelemetry/propagator-jaeger` 2.7.0 (fixed in no fix yet): OpenTelemetry JavaScript: Denial of service in `JaegerPropagator` via unhandled exception on a malformed header https://github.com/advisories/GHSA-45rx-2jwx-cxfr
- HIGH `nodemailer` 7.0.13 (fixed in >=9.0.1): Nodemailer: Message-level raw option bypasses disableFileAccess/disableUrlAccess, enabling arbitrary file read and full-response SSRF in the delivered message https://github.com/advisories/GHSA-p6gq-j5cr-w38f
- HIGH `nodemailer` 7.0.13 (fixed in >=9.1.0): Nodemailer: Quadratic (O(n²)) time complexity in addressparser allows remote denial of service via a crafted address list https://github.com/advisories/GHSA-2x7j-588g-ccc2
- HIGH `multer` 2.2.0 (fixed in >=2.3.0): multer vulnerable to Denial of Service via crafted multipart field names https://github.com/advisories/GHSA-wc9g-mqfw-jrwm
- HIGH `multer` 2.2.0 (fixed in no fix yet): multer vulnerable to Denial of Service via file descriptor leak on aborted uploads https://github.com/advisories/GHSA-qfvm-cv95-jqjf
- HIGH `multer` 2.2.0 (fixed in >=2.3.0): multer vulnerable to Denial of Service via oversized array index in field names https://github.com/advisories/GHSA-535w-7cp7-47q4
- HIGH `nodemailer` 7.0.13 (fixed in >=10.0.6): Nodemailer: Quadratic backtracking in the addressparser free-text fallback allows remote denial of service https://github.com/advisories/GHSA-v53p-9fqp-m79j
- HIGH `nodemailer` 7.0.13 (fixed in >=8.0.8): Nodemailer: Improper TLS Certificate Validation in OAuth2 Token Fetch Enables Credential Interception https://github.com/advisories/GHSA-r7g4-qg5f-qqm2
- HIGH `source-map-js` 1.2.1 (fixed in >=1.2.2): source-map-js allows event-loop denial of service through indexed source-map section offsets https://github.com/advisories/GHSA-68fv-2mgg-jv7q
- HIGH `@opentelemetry/exporter-prometheus` 0.215.0 (fixed in >=0.217.0): Prometheus exporter process crash via malformed HTTP request https://github.com/advisories/GHSA-q7rr-3cgh-j5r3
- HIGH `@opentelemetry/auto-instrumentations-node` 0.73.0 (fixed in >=0.75.0): Prometheus exporter process crash via malformed HTTP request https://github.com/advisories/GHSA-q7rr-3cgh-j5r3
- HIGH `@opentelemetry/sdk-node` 0.215.0 (fixed in >=0.217.0): Prometheus exporter process crash via malformed HTTP request https://github.com/advisories/GHSA-q7rr-3cgh-j5r3
- HIGH `follow-redirects` 1.16.0 (fixed in >=1.16.1): follow-redirects array-form headers bypass cross-origin credential stripping https://github.com/advisories/GHSA-q3jh-wrc6-jgq8
- HIGH `follow-redirects` 1.16.0 (fixed in >=1.16.1): follow-redirects sensitiveHeaders regex escaping can expose credential headers https://github.com/advisories/GHSA-8r9p-f939-6h3c
- HIGH `@graphql-tools/utils` 12.0.1 (fixed in >=12.0.2): GraphQL Tools: Prototype pollution in mergeIncrementalResult via non-primitive path segments https://github.com/advisories/GHSA-c4qx-w738-7hr3
- HIGH `zod` 4.6.5 (fixed in >=4.6.6): Zod can exhaust memory while validating oversized constrained collections https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- HIGH `body-parser` 2.3.0 (fixed in >=2.4.0): body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body https://github.com/advisories/GHSA-27r3-jxmh-p828
- HIGH `multer` 2.2.0 (fixed in >=2.5.0): multer vulnerable to Denial of Service via a pending asynchronous fileFilter after request teardown https://github.com/advisories/GHSA-q7qp-rjg7-q26m
- HIGH `undici` 8.11.2 (fixed in >=8.12.2): undici vulnerable to Denial of Service via unhandled error on excessive content-encodings https://github.com/advisories/GHSA-xjj6-f33q-929c
- HIGH `undici` 6.28.1 (fixed in >=6.29.1): undici vulnerable to Denial of Service via unhandled error on excessive content-encodings https://github.com/advisories/GHSA-xjj6-f33q-929c

(moderate and low: nodemailer, uuid, @opentelemetry/core, multer, js-yaml, @opentelemetry/instrumentation-pg, @opentelemetry/instrumentation-mysql2, @opentelemetry/instrumentation-knex, @opentelemetry/instrumentation-mysql, @opentelemetry/instrumentation-mongoose, @opentelemetry/instrumentation-oracledb, @opentelemetry/instrumentation-tedious, @opentelemetry/instrumentation-cassandra-driver, sanitize-html, undici)


---

## Verdicts after reading the code (by hand)

Real, and the one result of this track that needs action. `pnpm audit --prod` reads the whole lock file, so this page splits the list by which package pulls the dependency in.

**Web (`packages/web`)**
- **Next.js 16.3.8 has two CRITICAL and one HIGH advisory, fixed in 16.4.1**: unauthenticated remote code execution through the image optimizer when SVG files are used (GHSA-2464-fhr4-w9xw), remote code execution in `use cache` functions that return typed arrays (GHSA-673q-mjm6-r5xr), and a denial of service with Server Actions (GHSA-p3m5-59mp-jv5r). The app does use `'use cache'` (trending, product page, search) and Server Actions, so it is exposed to at least the third one. Whether the first two can be reached here was not tried (that needs a deliberate attack on the image route and a cached function returning a typed array); upgrading is the answer in any case. Severity: HIGH (critical by the advisory text, exploit path unconfirmed).
- DOMPurify 3.4.x (used in `lib/safe-html.ts` for seller and buyer text): one CRITICAL ("SAFE_FOR_TEMPLATES bypass", only matters if that option is used) and one HIGH (hook leaves event handlers armed), fixed in 3.4.17. The app sanitizes seller text with this library, so update. Severity: medium-high.
- `sharp` (HIGH, via an SVG library), `undici` (several HIGH/MODERATE DoS and one TLS check bypass), `@modelcontextprotocol/sdk` (HIGH), `body-parser`, `follow-redirects`, `source-map-js`, `zod <4.6.6` (HIGH): all have a fixed version; most are denial of service on the server side.

**Backend (`packages/backend`)**
- `multer` 2.2.0 (HIGH, four denial-of-service advisories: crafted multipart field names, leaked file descriptors on aborted uploads, huge array index, pending file filter). It sits in the upload path of the media area. Fixed in 2.5.0. Severity: medium-high (a logged-in user can make the API slow or crash).
- `nodemailer` (several HIGH/MODERATE; the app sends mail through it): fixed in 10.x. `undici`, `@opentelemetry/*` (HIGH), `@graphql-tools/utils`, `zod`, `sanitize-html` (MODERATE, used for text), `uuid`, `js-yaml`: all have fixes.

The full counts per package are at the top of this page. Nothing here was changed (rule: no product edits); this goes to the register as a dependency-update task. Many of these are in the `pnpm.overrides` / lock-file only and fixed by `pnpm update`.
