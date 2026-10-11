# Contract — web modules and URLs (`packages/web`)

Names are the public surface other capabilities import. Stand-ins from W07 keep their names and props.

## URLs

`/login` · `/login/mfa` · `/register` · `/forgot-password` · `/reset-password#token=…` · `/account` → `/account/security?tab=two-step|sessions|methods`. Query: `returnTo`, `notice` (`registered|signed_out|signed_out_everywhere|session_expired|password_reset`), `error` (S02 FR-048 closed list), `linked=google`. `/mfa` removed. `/reset-password` response header `Referrer-Policy: no-referrer` (rule added to `lib/security/headers.ts`, W07's module, as a path rule it already supports).

## Modules

| Module | Exports |
|---|---|
| `lib/api/csrf.ts` | `csrfHeaders(): Record<'X-CSRF-Token', string> \| {}`; `hasCsrfCookie(): boolean` |
| `lib/api/client.ts` | `apiClient` (relative, `withCredentials`, CSRF on non-GET unless `anonymous: true`); no token API (`setAccessToken`, `getAccessToken`, `refreshSession` deleted) |
| `lib/api/errors.ts` | `problemFromError(error): Problem`; `waitText(seconds)` re-export; `Problem` type |
| `lib/api/session.ts` | `sessionApi.{login, verifyMfa, current, logout, refresh}` returning `SessionResult` with typed `code` (as S48 left it, plus `refresh`) |
| `lib/api/auth.ts` | `register`, `requestPasswordReset`, `confirmPasswordReset` (anonymous) |
| `lib/api/account.ts` | `getMfaStatus`, `enrollMfa`, `confirmMfa`, `regenerateRecoveryCodes`, `disableMfa`, `listSessions`, `revokeSession`, `logoutAll`, `listIdentities`, `unlinkIdentity`, `listOidcProviders`, `startOidc`, `startOidcLink` — every response parsed with the contracts schema; a parse failure is a `Problem` with `status: 500` |
| `lib/auth/return-to.ts` | `safeReturnTo(raw)`, `loginHref(returnTo)` |
| `lib/auth/session.server.ts` | `getServerSession()`, `requireServerSession(returnTo)` (`server-only`) |
| `lib/auth/guards.ts` | `authPageRedirect({user, returnTo, error})` pure |
| `lib/auth/session-sync.ts` | `announceAuth(type)`, `subscribeAuth(handler)` |
| `lib/auth/session-ended.ts` | `endSession()` (one-shot), `rearmSessionEnd()` |
| `lib/auth/retry-after.ts` | `formatWait(seconds \| null)` |
| `lib/auth/copy.ts` | notices, errors, provider errors, field messages (FR-043/FR-044) |
| `hooks/use-auth.tsx` | `useAuth()` read-only; `AuthBootstrap` |
| `hooks/use-auth-actions.ts` | `useLogin`, `useVerifyMfa`, `useLogout`, `useRefreshSession` |
| `components/auth/account-slot.tsx` | `AccountSlot`, `AccountSlotSkeleton`, `MobileAccountEntries` (same names/props as the W07 stand-in; Admin entry through `isAdmin` from `lib/admin/is-admin`) |
| `components/auth/problem-alert.tsx` | `ProblemAlert({problem, context})` |

## Behavioural guarantees

After sign-in all non-session queries are invalidated; after sign-out/expiry the cache is empty; a 401 with `session_expired|unauthenticated|invalid_token` from any shared-client request while a user is cached runs `endSession()` exactly once.
