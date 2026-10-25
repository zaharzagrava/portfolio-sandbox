Real, and the one result of this track that needs action. `pnpm audit --prod` reads the whole lock file, so this page splits the list by which package pulls the dependency in.

**Web (`packages/web`)**
- **Next.js 16.3.8 has two CRITICAL and one HIGH advisory, fixed in 16.4.1**: unauthenticated remote code execution through the image optimizer when SVG files are used (GHSA-2464-fhr4-w9xw), remote code execution in `use cache` functions that return typed arrays (GHSA-673q-mjm6-r5xr), and a denial of service with Server Actions (GHSA-p3m5-59mp-jv5r). The app does use `'use cache'` (trending, product page, search) and Server Actions, so it is exposed to at least the third one. Whether the first two can be reached here was not tried (that needs a deliberate attack on the image route and a cached function returning a typed array); upgrading is the answer in any case. Severity: HIGH (critical by the advisory text, exploit path unconfirmed).
- DOMPurify 3.4.x (used in `lib/safe-html.ts` for seller and buyer text): one CRITICAL ("SAFE_FOR_TEMPLATES bypass", only matters if that option is used) and one HIGH (hook leaves event handlers armed), fixed in 3.4.17. The app sanitizes seller text with this library, so update. Severity: medium-high.
- `sharp` (HIGH, via an SVG library), `undici` (several HIGH/MODERATE DoS and one TLS check bypass), `@modelcontextprotocol/sdk` (HIGH), `body-parser`, `follow-redirects`, `source-map-js`, `zod <4.6.6` (HIGH): all have a fixed version; most are denial of service on the server side.

**Backend (`packages/backend`)**
- `multer` 2.2.0 (HIGH, four denial-of-service advisories: crafted multipart field names, leaked file descriptors on aborted uploads, huge array index, pending file filter). It sits in the upload path of the media area. Fixed in 2.5.0. Severity: medium-high (a logged-in user can make the API slow or crash).
- `nodemailer` (several HIGH/MODERATE; the app sends mail through it): fixed in 10.x. `undici`, `@opentelemetry/*` (HIGH), `@graphql-tools/utils`, `zod`, `sanitize-html` (MODERATE, used for text), `uuid`, `js-yaml`: all have fixes.

The full counts per package are at the top of this page. Nothing here was changed (rule: no product edits); this goes to the register as a dependency-update task. Many of these are in the `pnpm.overrides` / lock-file only and fixed by `pnpm update`.
