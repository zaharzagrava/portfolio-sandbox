# Fix plan, round 1 (2026-10-25)

Source: docs/work/qa-bug-register.md. Five fixers in parallel, one owner per shared file. Candidates are fixed when the fixer can reproduce them; false alarms and dev-only noise (B-003, B-027) are skipped. Product choices: decided by the fixer (portfolio showcase, no over-engineering, patterns from docs/work/architecture/pattern-map.md where they fit).

## Fixer X: cross-cutting (owns the shared files)
- Sign-in return path (B-023): `components/dashboard/shop-frame.tsx` guard cuts returnTo to the shop root; keep path and query on every seller page; `/orders?page=2` too.
- Offline and outage behaviour (B-071, B-074, B-082, B-096; B-089, B-090, B-091): one refetch on reconnect; a write pressed offline says so (W04.B-35 text) instead of silently parking; a client-side timeout with an honest "try again" for writes and uploads, so frozen database, Redis, storage or queue never leave a silent spinner.
- Suspended and closing shops (B-024, B-081, B-099): reads stay allowed (W04.R-03): allow products.read, orders.read and the gallery read in the shop-access rule while SUSPENDED/DELETING (update S03.R-05 text to match), refused writes show the banner and disable controls, photos page shows the photos read-only.
- Not-found (B-026, B-065, B-084): real 404 status where the framework allows, a not-found title, a clean page for malformed addresses.
- Focus and busy state shared primitives (B-072, B-054, B-080, B-079): dialogs return focus to the opener on Cancel/Escape, `aria-busy` + dimmed rows while the next page loads, drawer behind-content hidden from assistive tech and closed on resize to desktop.
- Shared layout (B-078, B-086): long names and long words never make pages scroll sideways (break-words/min-w-0 in the page head and table cells).
- Accessibility (B-061, B-053, B-066 duplicate ids): skip-link aria-hidden-focus, dialog colour contrast, unique accessible names and ids.
- Dependencies (B-056, B-057, B-058, B-059): upgrade Next.js to 16.4.1, DOMPurify to 3.4.17, multer to 2.5.0, and other advisories with a fix that do not break the build (nodemailer, undici); fix the BigInt literal type error in `lib/seller/seller-logic.property.test.ts`; run the production build once.
- Media address (B-002, B-077): `MEDIA_CDN_URL` points at port 9100 (MinIO) in env examples and dev env generators, the dev bucket is public-read for derived files, the web CSP/image allow-list matches; decide http vs https for dev so the product page main image shows.
- Rate-limit UI (B-098): disable the causing control during the countdown (`ProblemPanel` `onActiveChange`).

## Fixer entry
B-037, B-083 (invalid cursor code and friendly page), B-038 (accents in handle), B-039 (first click lost), B-040 (role refresh early stop: `session.role` vs `user.role`), B-041 (handle maxLength 40), B-042 (empty picker text), B-085 (unique tab titles + route announcer), B-084 if left, plus any entry test mistakes.

## Fixer inventory
B-028, B-032 (Load latest everywhere; archived-elsewhere text), B-029 + B-050-style URL normalization (unsupported values become defaults, defaults left out, repeated keys), B-030 (search length limit 100 with a clear message), B-033 (decide: archived rows never listed under In stock), B-034 (Idempotency-Key on writes), B-051 (repeated status keys), B-067 (640 px rule), B-068 (emoji length counting), B-069 (trim before count), B-070 (plan_limit_reached message), B-088 (emoji search: decide), B-097 (double Update stock: ref guard).

## Fixer media
B-043 (archived product: disable chooser/Remove, refetch hint acted on), B-044 (animated PNG rejected), B-045 (message for dropped files), B-046 (not-found text and no Try again on 404), B-047 (ERR_ABORTED log), B-073 (focus after keyboard move), B-075 (conflict sentence about photos), B-076 (live region for moves), B-100 (Save must send the version the draft started from; 409 on mismatch), the old fixme test key `payload.rejectCode` -> `payload.code`.

## Fixer orders (and backend leaks)
B-035 (remove buyerId from API and page), B-036 (readable unique order reference), B-048 (orders skeleton shape), B-049 (unknown currency never crashes the page), B-050 + B-051 + B-095 (status filter rules and first-page link keeps the filter), B-052 (precision/2^53 safe amounts, one bad row never hides the list), B-087 (dates in the viewer's time zone), B-093 (out-of-stock checkout leaves no Cancelled order in the seller list), B-060 (invites 500 for lone surrogate e-mail), orders-page.spec mobile test mistake (hidden sidebar link click), B-063 (OpenAPI gaps: document the four areas' routes and answers).

## Not in round 1
B-062 (ERR_SSL on the e2e build, candidate), B-005 (rare hydration error, candidate: investigate if time), B-064 (dev DB superuser, info), rate-limit and scanner lines blocked by the stack.
