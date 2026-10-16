---
id: main-journeys
title: Main journeys
kind: term
status: draft
aliases: [journeys]
defined_for: W07-app-shell
rules_hash: 4c7824885945
---
# Main journeys
## Definition
Main journeys are the key visitor paths through the web app. The team runs them against the [production build](production-configuration.md) to check the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy). The check passes only if the browser reports no [CSP violations ↗](../sw-external-terms.md#csp-violation-report) during those journeys. This shows that the [enforced policy ↗](../sw-external-terms.md#csp-report-only) does not block anything the app really needs.

## Example
A test runs the production build and walks from the home page (`/`) to `/search`, then to a product page and into [`/checkout/pay/*`](checkout-pay-route.md) (this route is illustrative). It then checks that the browser recorded zero CSP violations.

## Known gaps
- The spec does not say which journeys count as "main journeys". The route sequence in the example is illustrative only.
- The spec does not say whether the journeys run signed in, signed out or both.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): B-12
- [payout-paid-event](payout-paid-event.md)
- [payout-status](payout-status.md)
- [production-configuration](production-configuration.md)
<!-- used-by:end -->
