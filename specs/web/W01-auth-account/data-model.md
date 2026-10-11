# W01 — Data model

The browser holds no durable account data. One backend table is added (password reset).

## Browser-side entities

| Entity | Fields | Home | Rules |
|---|---|---|---|
| `SessionUser` | `id: string`, `email: string \| null`, `role: 'USER'\|'SELLER'\|'MODERATOR'\|'ADMIN'` | TanStack Query `queryKeys.auth.session()` (value `{user, expiresAt} \| null`) | from `sessionResponseSchema`; never copied to state/Context; server bootstrap passes only these three fields |
| `AuthStatus` | `loading \| authenticated \| anonymous \| unavailable` | derived in `useAuth()` | `unavailable` keeps the previous user |
| `Problem` | `status: number\|null`, `code: string\|null`, `errors: {field, code}[]`, `retryAfterSeconds: number\|null`, `requestId: string\|null` | produced by `problemFromError` | no `title`/`detail`; `lib/problem.ts` (W07 stand-in) re-exports it with W07's current optional-field callers kept compiling (`status` 0 for no response is kept as the "no response" marker; R-04) |
| `Notice`, `ProviderError` | allowlisted string unions (FR-043/FR-044) | URL | unknown values ignored |
| `MfaStatus` | `state: none\|pending\|enabled`, `enabledAt?`, `recoveryCodesRemaining?` | `queryKeys.auth.mfaStatus()` | `mfaStatusSchema` |
| `SetupSecret`, `RecoveryCodes` | `{otpauthUri, manualEntryKey}`, `string[10]` | component state of the open dialog only | `gcTime: 0` mutations; cleared on unmount; never in cache/storage/URL |
| `SessionItem` | `sessionId, device, ip, createdAt, lastUsedAt, current` | `queryKeys.auth.sessions()` | newest first; `current` row has no revoke control |
| `LinkedIdentity` | `id, provider, email\|null, linkedAt` | `queryKeys.auth.identities()` | |
| `OidcProvider` | `id, displayName` | `queryKeys.auth.oidcProviders()` | |
| `ResetToken` | string | `useRef` in `ResetPasswordForm` | read from `location.hash`, removed via `history.replaceState`, never in state/URL |
| `AuthMessage` | `{type: 'signed-in'\|'signed-out'}` | `BroadcastChannel('auth')` | no user data |

### Query keys (`lib/query-keys.ts`)

`auth.session()` · `auth.mfaStatus()` · `auth.sessions()` · `auth.identities()` · `auth.oidcProviders()`; `auth.user` removed.

### Client leaves (all others are Server Components)

`LoginForm`, `GoogleButton`, `RegisterForm`, `MfaForm`, `ForgotPasswordForm`, `ResetPasswordForm`, `AuthBanner` (only if it needs `useSearchParams`; otherwise server), `SecurityTabs`, `TwoStepPanel`, `RecoveryCodesDialog`, `SessionsPanel`, `SignInMethodsPanel`, `AccountMenu`, `AccountSlotClient` (retry button, online/focus listeners), `SessionBootstrap`, `PasswordInput`, `CodeInput`, `ProblemAlert`.

## State transitions

- **Session**: `loading → authenticated | anonymous | unavailable`; `authenticated → anonymous` on logout success, expiry flow, `signed-out` message; `authenticated → unavailable → authenticated` on retry/online/focus; `anonymous → authenticated` on login, MFA success, `signed-in` message.
- **Sign-in form**: `idle → submitting → (navigate | error | throttled(timer) → idle)`; MFA required → navigate to `/login/mfa` (history replaced).
- **MFA form**: `code ⇄ recovery → submitting → (navigate | wrong | throttled | timed-out(terminal))`.
- **Reset page**: `reading-token → (form | invalid-link)`; `form → submitting → (success | form with error)`.
- **Two-step**: `none → [Set up] step1 → step2 → step3(codes) → enabled`; `pending → [Start over] → step1`; `enabled → [regenerate] dialog → codes`; `enabled → [Turn off] dialog → none`. Any `409` closes the dialog and refetches.
- **Expiry flow**: `armed → ended` once; re-armed on the next successful sign-in.

## Backend table (identity schema)

`identity.password_reset_tokens`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid, FK `identity.users(id)` on delete cascade | index |
| `token_digest` | char(64) unique | SHA-256 hex of the token; the token is never stored |
| `expires_at` | timestamptz | `created_at + 30 min` |
| `used_at` | timestamptz null | single use |
| `created_at` | timestamptz default now | |

Migration under `packages/backend/migrations` (next free number). Requesting a reset sets `used_at = now()` on the user's older unused rows (only the newest link works). A scheduled prune is out of scope (rows are tiny; `expires_at` index added).
