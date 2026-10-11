# Contract — what W07 provides and mounts

## Provides (exact names)

- `components/layout/system-states.tsx`: `NotFoundState({ title?, description?, actions? })`, `ErrorState({ problem?, reference?, onRetry? })` (renders nothing for `401`), `AccessDeniedState()`; `components/layout/page-skeleton.tsx`: `PageSkeleton({ variant: 'detail' | 'list' | 'form' })`.
- Route files: `app/not-found.tsx`, `error.tsx`, `global-error.tsx`, `loading.tsx`, `robots.ts`, `health/route.ts`.
- `lib/routes/page-name.ts`: `pageNameFor(pathname: string, matchedTemplate?: string): string`.
- `lib/security/csp.ts`, `lib/security/headers.ts`, `lib/config.ts`, `lib/providers.tsx` (query defaults), `lib/query-keys.ts` (+ `queryKeys.developers.openapi`).
- `components/layout/skip-link.tsx`, `route-focus.tsx`.
- `tests/helpers.ts`: `expectNoCspViolations(page)`, `gotoAtWidth(page, 'mobile' | 'desktop', path)`, `headersOf(request, path)`.
- `GET /health` → `200 {"status":"ok"}`, `no-store`. `GET /widget/v1/app.js` (configurable).

## Mounts (names owned by siblings; stand-ins created where absent, see research R-08)

`AccountSlot`, `AccountSlotSkeleton`, `MobileAccountEntries` (W01) · `SearchBox variant="navbar"` (W02) · `CartBadge`, `NotificationsPopover` (W03) · `AssistantLauncher variant="icon" | "menu-item"`, optional `ChatNavBadge` (W05) · `isAdmin` (W06) · `track`, `problemFromError` (W02, W01).

## Header order (desktop)

logo → `nav "Main"` (Browse, Developers) → search → assistant → theme → cart → bell (members) → account. Tab order: skip link first, then the same order, page, footer.
