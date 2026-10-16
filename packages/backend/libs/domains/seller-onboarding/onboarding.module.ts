import { Module } from '@nestjs/common';
import { AuthModule, SecretBox } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { LlmModule } from '@app/infrastructure/llm';
import { OnboardingSessionService } from './application/onboarding-session.service';
import { OnboardingDocumentsService } from './application/onboarding-documents.service';
import { VerificationService } from './application/verification.service';
import { ReviewService } from './application/review.service';
import { ExtractionService } from './application/extraction.service';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import {
  APPLICATIONS,
  ATTEMPTS,
  DOCUMENTS,
  REVIEW_TASKS,
  STATUS_HISTORY,
} from './domain/ports';
import {
  EXTRACTION_CONFIG_KEYS,
  resolveExtractionConfig,
} from './domain/extraction-config';
import { EXTRACTION_CONFIG } from './application/extraction-config.token';
import { VerificationPolicyService } from './application/verification-policy.service';
import { SequelizeApplicationRepository } from './infra/application.repository';
import { SequelizeAttemptRepository } from './infra/attempt.repository';
import { SequelizeDocumentRepository } from './infra/document.repository';
import { SequelizeReviewTaskRepository } from './infra/review-task.repository';
import { SequelizeStatusHistoryRepository } from './infra/status-history.repository';
import { OnboardingJobs } from './infra/onboarding.jobs';
import {
  OnboardingController,
  OnboardingReviewController,
} from './api/onboarding.controller';

/** SD-44 (core): questionnaire, uploads, review queue. */
@Module({
  imports: [
    AuthModule,
    StorageModule,
    SqsModule,
    EventsModule.forAggregates([
      { aggregateType: 'shops', retention: 'full-history' },
    ]),
    JobsModule,
  ],
  providers: [
    OnboardingSessionService,
    OnboardingDocumentsService,
    VerificationService,
    ReviewService,
  ],
  exports: [VerificationService],
  controllers: [OnboardingController, OnboardingReviewController],
})
export class OnboardingModule {}

/**
 * SD-44 extraction (Lambda `document-extractor`, or any worker): no HTTP, no
 * auth stack - SecretBox is provided directly.
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
  providers: [
    ExtractionService,
    VerificationService,
    VerificationPolicyService,
    SecretBox,
    { provide: APPLICATIONS, useClass: SequelizeApplicationRepository },
    { provide: DOCUMENTS, useClass: SequelizeDocumentRepository },
    { provide: ATTEMPTS, useClass: SequelizeAttemptRepository },
    { provide: REVIEW_TASKS, useClass: SequelizeReviewTaskRepository },
    { provide: STATUS_HISTORY, useClass: SequelizeStatusHistoryRepository },
    {
      provide: EXTRACTION_CONFIG,
      // Resolved at boot, so an invalid setting fails the start (VIII.5). The keys are the lower-case config names; the
      // environment carries them in upper case (most are not in the typed `Config`).
      useFactory: () =>
        resolveExtractionConfig(
          Object.fromEntries(
            EXTRACTION_CONFIG_KEYS.map((key) => [
              key,
              process.env[key.toUpperCase()],
            ]),
          ),
        ),
    },
  ],
  exports: [ExtractionService],
})
export class OnboardingExtractionModule {}

/** SD-44 (worker): retention job. */
@Module({ imports: [StorageModule], providers: [OnboardingJobs] })
export class OnboardingWorkerModule {}
