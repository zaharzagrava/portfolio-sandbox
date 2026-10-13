---
id: security-headers-module
title: Security headers module
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# Security headers module
## Definition
The security headers module is the web app file that holds the fixed security header settings for responses. It exports [`staticSecurityHeaders`](static-security-headers.md), the static security headers that every response must carry. It also exports [`noStorePaths`](no-store-paths.md), the [signed-in areas](signed-in-areas.md) whose responses must carry [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). It only covers headers that stay the same on every response. [`buildCsp`](build-csp.md) in a separate file builds the per-response [Content Security Policy ↗](../sw-external-terms.md#content-security-policy).

## Example
The module lives at `packages/web/lib/security/headers.ts`. Its two exports produce headers like these:
```
X-Content-Type-Options: nosniff        # staticSecurityHeaders, every response
X-Frame-Options: DENY                  # staticSecurityHeaders, every response
Cache-Control: no-store                # only on paths in noStorePaths
```

## Known gaps
- The spec does not say what code applies these headers to responses. The facts say only that the proxy applies the CSP.
- The spec does not give the full list of `staticSecurityHeaders` or the paths in `noStorePaths`.
- Not confirmed in the code: a decision says that the robots list and the no-store list come from one list of private areas. The facts do not show whether `noStorePaths` is that list or is built from it.

## Used by
<!-- used-by:start -->
- [no-store-paths](no-store-paths.md)
- [signed-in-areas](signed-in-areas.md)
- [static-security-headers](static-security-headers.md)
<!-- used-by:end -->
