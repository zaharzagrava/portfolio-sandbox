Read all 8 warnings (0 failures, 60 checks passed). The scan ran against the PRODUCTION build, and 60 of 68 checks passed including cookie flags, X-Frame-Options, HSTS, CSP present, no server version leaks, no open redirect. Verdicts:

- "PII Disclosure" (rated High by ZAP): FALSE ALARM. ZAP saw a 12-digit number on a product page and took it for a card number. The number did not appear again when the page was fetched by hand (it comes from the page's own random/time values) and no card data is stored on that page.
- "Authentication Request Identified", "Sensitive Information in URL" (email, password in `/login?email=...&password=ZAP`): FALSE ALARM. ZAP invented those query parameters itself to test the form; the app never builds such URLs. Worth one check by a person: after a wrong sign-in the app must not copy the password into the address (it did not in the pages ZAP saw).
- "User Controllable HTML Element Attribute (Potential XSS)" on `/search?q=...`: FALSE ALARM. Tried by hand with `"><svg onload=alert(1)>` as the search text: it comes back encoded (`&quot;&gt;&lt;svg ...`) in the title, the input value and the page data. No script runs.
- "Content-Type Header Missing" for `/account/`, `/admin`, `/api/`: FALSE ALARM, those are redirect answers (307) with an empty body.
- "Non-Storable Content": intended, the pages say `Cache-Control: no-store`.
- "CSP: Notices": only the note that `report-uri` is deprecated in favour of `report-to`. LOW, cosmetic. The policy itself is strict (nonce plus `strict-dynamic`, no `unsafe-inline` for scripts or style elements); it allows `style-src-attr 'unsafe-inline'` only for style attributes.
- "Cross-Origin-Embedder-Policy / Cross-Origin-Resource-Policy Header Missing" (9 places): REAL but only a hardening wish, LOW. COOP is set (`same-origin-allow-popups`); COEP/CORP are not. Setting them can break embeds (maps, widget), so it is a product choice, not a bug.

Limit: a baseline scan is passive (it looks at what the server answers, it does not attack, and it did not sign in), so the seller dashboard behind the login was not scanned. An authenticated active scan was not run.
