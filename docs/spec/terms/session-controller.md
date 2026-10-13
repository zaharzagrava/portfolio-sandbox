---
id: session-controller
title: SessionController
kind: term
status: draft
aliases: []
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# SessionController
## Definition
`SessionController` is the backend class in the [BFF composition library](bff-composition-library.md) that handles sign-in through the [BFF ↗](../sw-external-terms.md#bff). It receives the browser's request at `POST /api/bff/session`. It exists so that sign-in goes through the BFF and browser code never holds an [access token](access-token.md) (FR-001). The spec says only that this endpoint is owned by [S01, S02 or S48](../capabilities/S01-auth-sessions.md). It does not say which one.

## Example
A visitor presses **Sign in** on the login page. The account has [two-step verification](mfa-state.md) turned on.
```
POST /api/bff/session        (relative same-origin URL; no [X-CSRF-Token ↗](../sw-external-terms.md#csrf-token), because the visitor is still anonymous)
→ 200 {"mfaRequired": true}  → the browser goes to /login/mfa?returnTo=… with history replaced
```
The class is in `packages/backend/libs/composition/bff/session/session.controller.ts`.

## Known gaps
- Not confirmed in the code: whether `SessionController` also serves `POST /api/bff/session/mfa`, `GET /api/bff/session`, `POST /api/bff/session/refresh` and `POST /api/bff/session/logout`. The spec links it only to sign-in.
- The spec does not say which capability owns `SessionController`: S01, S02 or S48.
- Not confirmed in the code: whether `SessionController` sets the [`__Host-bff-*` cookies](host-bff-cookies.md) and writes the session record to the [session store](session-store.md) itself, or whether another part of the BFF does this.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [bff-composition-library](bff-composition-library.md)
- [host-bff-cookies](host-bff-cookies.md)
- [mfa-state](mfa-state.md)
- [session-store](session-store.md)
<!-- used-by:end -->
