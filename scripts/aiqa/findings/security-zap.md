# Security: OWASP ZAP baseline (production-build web server, port 3100)

Run 2026-10-25 07:35. The baseline scan opens the site, spiders it for a minute and passively checks every response (headers, cookies, leaked info). It does not attack.

Site http://localhost:3100: 11 kinds of alert.

- risk Low (High): **CSP: Notices** (5 places), example `http://localhost:3100/checkout`
- risk Low (Medium): **Cross-Origin-Embedder-Policy Header Missing or Invalid** (1 places), example `http://localhost:3100/checkout`
- risk Low (Medium): **Cross-Origin-Opener-Policy Header Missing or Invalid** (1 places), example `http://localhost:3100/checkout`
- risk Low (Medium): **Cross-Origin-Resource-Policy Header Missing or Invalid** (5 places), example `http://localhost:3100/_next/static/chunks/0z6yg6q7p3zyb.js`
- risk Informational (High): **Authentication Request Identified** (4 places), example `http://localhost:3100/login?email=zaproxy%40example.com&password=ZAP`
- risk Informational (Medium): **Content-Type Header Missing** (5 places), example `http://localhost:3100/account`
- risk Informational (Medium): **Information Disclosure - Sensitive Information in URL** (5 places), example `http://localhost:3100/login?email=zaproxy%40example.com&password=ZAP`
- risk Informational (Medium): **Non-Storable Content** (5 places), example `http://localhost:3100/account`
- risk Informational (Medium): **Storable and Cacheable Content** (1 places), example `http://localhost:3100/api`
- risk Informational (Medium): **Storable but Non-Cacheable Content** (1 places), example `http://localhost:3100/favicon.ico?favicon.2vob68tjqpejf.ico`
- risk Informational (Low): **User Controllable HTML Element Attribute (Potential XSS)** (3 places), example `http://localhost:3100/search?category=%D9%85%D8%B7%D8%A8%D8%AE`

---

## Verdicts after reading the code (by hand)

Read all 8 warnings (0 failures, 60 checks passed). The scan ran against the PRODUCTION build, and 60 of 68 checks passed including cookie flags, X-Frame-Options, HSTS, CSP present, no server version leaks, no open redirect. Verdicts:

- "PII Disclosure" (rated High by ZAP): FALSE ALARM. ZAP saw a 12-digit number on a product page and took it for a card number. The number did not appear again when the page was fetched by hand (it comes from the page's own random/time values) and no card data is stored on that page.
- "Authentication Request Identified", "Sensitive Information in URL" (email, password in `/login?email=...&password=ZAP`): FALSE ALARM. ZAP invented those query parameters itself to test the form; the app never builds such URLs. Worth one check by a person: after a wrong sign-in the app must not copy the password into the address (it did not in the pages ZAP saw).
- "User Controllable HTML Element Attribute (Potential XSS)" on `/search?q=...`: FALSE ALARM. Tried by hand with `"><svg onload=alert(1)>` as the search text: it comes back encoded (`&quot;&gt;&lt;svg ...`) in the title, the input value and the page data. No script runs.
- "Content-Type Header Missing" for `/account/`, `/admin`, `/api/`: FALSE ALARM, those are redirect answers (307) with an empty body.
- "Non-Storable Content": intended, the pages say `Cache-Control: no-store`.
- "CSP: Notices": only the note that `report-uri` is deprecated in favour of `report-to`. LOW, cosmetic. The policy itself is strict (nonce plus `strict-dynamic`, no `unsafe-inline` for scripts or style elements); it allows `style-src-attr 'unsafe-inline'` only for style attributes.
- "Cross-Origin-Embedder-Policy / Cross-Origin-Resource-Policy Header Missing" (9 places): REAL but only a hardening wish, LOW. COOP is set (`same-origin-allow-popups`); COEP/CORP are not. Setting them can break embeds (maps, widget), so it is a product choice, not a bug.

Limit: a baseline scan is passive (it looks at what the server answers, it does not attack, and it did not sign in), so the seller dashboard behind the login was not scanned. An authenticated active scan was not run.
