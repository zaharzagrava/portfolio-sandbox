import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors';
import { AuthModule, SecretBox } from '@app/domains/identity';
import { ShopQueryModule } from '@app/domains/tenancy';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { LlmModule } from '@app/infrastructure/llm';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { OnboardingSessionService } from './application/onboarding-session.service';
import { OnboardingDocumentsService } from './application/onboarding-documents.service';
import { ReviewService } from './application/review.service';
import { ExtractionService } from './application/extraction.service';
import { VerificationPolicyService } from './application/verification-policy.service';
import { RetentionScheduler } from './application/retention-scheduler';
import { OnboardingAudit } from './application/onboarding-audit';
import { OnboardingLimits } from './application/onboarding-limits';
import { EXTRACTION_CONFIG } from './application/extraction-config.token';
import {
  APPLICATIONS,
  ATTEMPTS,
  DOCUMENTS,
  DRAFTS,
  REVIEW_TASKS,
  STATUS_HISTORY,
} from './domain/ports';
import {
  EXTRACTION_CONFIG_KEYS,
  resolveExtractionConfig,
} from './domain/extraction-config';
import { ONBOARDING_PROBLEMS } from './domain/errors';
import { onboardingRatePolicies } from './rate-limit-policies';
import { SequelizeApplicationRepository } from './infra/application.repository';
import { SequelizeAttemptRepository } from './infra/attempt.repository';
import { SequelizeDocumentRepository } from './infra/document.repository';
import { SequelizeReviewTaskRepository } from './infra/review-task.repository';
import { SequelizeStatusHistoryRepository } from './infra/status-history.repository';
import { RedisDraftStore } from './infra/draft.store';
import { ExtractionQueueReadiness } from './infra/queue-readiness';
import { OnboardingJobs } from './infra/onboarding.jobs';
import { OnboardingShopDeletedConsumer } from './infra/shop-deleted.consumer';
import { RetentionService } from './application/retention.service';
import { OnboardingController } from './api/onboarding.controller';
import { OnboardingReviewController } from './api/review.controller';

/** The adapters of the repository ports (R-10); every module that hosts a service of this domain lists them. */
const REPOSITORIES = [
  { provide: APPLICATIONS, useClass: SequelizeApplicationRepository },
  { provide: DOCUMENTS, useClass: SequelizeDocumentRepository },
  { provide: ATTEMPTS, useClass: SequelizeAttemptRepository },
  { provide: REVIEW_TASKS, useClass: SequelizeReviewTaskRepository },
  { provide: STATUS_HISTORY, useClass: SequelizeStatusHistoryRepository },
];

/**
 * Validated at boot, so an invalid setting fails the start (VIII.5, AS-69). The keys are the lower-case config names; the
 * environment carries them in upper case (most are not in the typed `Config`).
 */
const EXTRACTION_CONFIG_PROVIDER = {
  provide: EXTRACTION_CONFIG,
  useFactory: () =>
    resolveExtractionConfig(
      Object.fromEntries(
        EXTRACTION_CONFIG_KEYS.map((key) => [
          key,
          process.env[key.toUpperCase()],
        ]),
      ),
    ),
};

/** The decision logic shared by the web app (review) and the worker/Lambda (extraction). */
const DECISION_PROVIDERS = [
  ...REPOSITORIES,
  EXTRACTION_CONFIG_PROVIDER,
  RetentionScheduler,
  VerificationPolicyService,
];

/** SD-44 (core): questionnaire, uploads, review queue. Exports nothing (nobody else needs its services). */
@Module({
  imports: [
    AuthModule,
    StorageModule,
    SqsModule,
    EventsModule.forAggregates([
      { aggregateType: 'shops', retention: 'full-history' },
    ]),
    JobsModule,
    ShopQueryModule,
    RateLimitModule.forFeature(onboardingRatePolicies),
    ProblemCatalogModule.forFeature(ONBOARDING_PROBLEMS),
  ],
  providers: [
    ...DECISION_PROVIDERS,
    { provide: DRAFTS, useClass: RedisDraftStore },
    OnboardingLimits,
    OnboardingAudit,
    ExtractionQueueReadiness,
    OnboardingSessionService,
    OnboardingDocumentsService,
    ReviewService,
  ],
  controllers: [OnboardingController, OnboardingReviewController],
})
export class OnboardingModule {}

/**
 * SD-44 extraction (Lambda `document-extractor`, or any worker): no HTTP, no auth stack - SecretBox is provided
 * directly. Boots on its own (L-018): the LLM port, storage, clock, events and jobs are all it needs.
 */
@Module({
  imports: [
    LlmModule,
    StorageModule,
    ClockModule,
    EventsModule.forAggregates([
      { aggregateType: 'shops', retention: 'full-history' },
    ]),
    JobsModule,
  ],
  providers: [...DECISION_PROVIDERS, ExtractionService, SecretBox],
  exports: [ExtractionService],
})
export class OnboardingExtractionModule {}

const RETENTION_PROVIDERS = [
  ...REPOSITORIES,
  EXTRACTION_CONFIG_PROVIDER,
  RetentionService,
];

/** SD-44 (worker): the retention jobs (purge of a round's raw files, erasure of a deleted shop's records). */
@Module({
  imports: [StorageModule, JobsModule, ClockModule],
  providers: [...RETENTION_PROVIDERS, OnboardingJobs],
})
export class OnboardingWorkerModule {}

/** The event consumers of this capability (apps/projector registers them from `projectors`). */
@Module({
  imports: [StorageModule, JobsModule, ClockModule],
  providers: RETENTION_PROVIDERS,
  // The projection framework builds the consumers in its own module, so what they inject must be exported.
  exports: [RetentionService],
})
export class OnboardingProjectorModule {
  static readonly projectors = [OnboardingShopDeletedConsumer];
}
