# Service contracts: S04

## Exports of `@app/domains/seller-onboarding` (X.4)

- `OnboardingModule` (HTTP core), `OnboardingExtractionModule` (worker/Lambda), `OnboardingWorkerModule` (jobs and `tenancy.shop_deleted` consumer).
- `ExtractionService.process(documentId: string): Promise<void>`, `ExtractionService.routeToReview(documentId: string, reason: string): Promise<void>` (idempotent).
- Contract types re-exported from `packages/contracts`. Nothing else: no models, no repositories, no `VerificationService` (nobody imports it).

## Imports (Requires)

| From | Symbol | Use |
|---|---|---|
| tenancy | `ShopScoped`, `ShopQueryService.getShopsByIds(ids ≤ 500)`, `ShopAccessService.getRole(shopId, userId)` | route guard, queue shop names (one call per page), conflict of interest |
| identity | `Firewall`, `User`, `SecretBox`/`SecretSealerPort` `seal(plain, context)`/`open(sealed, context)` | admin guard, sealed fields with `kyc:<documentId>:<attempt>` |
| `@app/infrastructure/llm` | `LLM_PROVIDER`, `LlmUnavailableError`, `LlmRejectedError`, `LlmCallRecorder` (`maxRetries: 0`, `timeoutMs: 45000`) | extraction |
| infrastructure | `OutboxService` (`append`, `appendTask`), `JobsService`, inbox consumer base, `RateLimiter` policies, `ObjectStorage` port, metrics registry, audit logger, `TransactionRunner`, `Clock` | as research.md |

## Internal ports (`domain/ports.ts`)

`ApplicationRepository` (lock, conditional transitions, history), `DocumentRepository` (claim with lease, conditional finish, supersede, caps), `AttemptRepository`, `ReviewTaskRepository` (keyset page, single-winner resolve, cancel), `DraftStore` (Redis hash), `ClockPort`. Adapters in `infra/`; unit-pure code receives `now` as an argument.
