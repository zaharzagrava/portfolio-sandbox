import { Module } from '@nestjs/common';
import { AuthModule, SecretBox } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { UsageService } from '@app/domains/billing';
import { LlmModule, LlmMeter } from '@app/domains/assistant';
import { OnboardingSessionService } from './application/onboarding-session.service';
import { OnboardingDocumentsService } from './application/onboarding-documents.service';
import { VerificationService } from './application/verification.service';
import { ReviewService } from './application/review.service';
import { ExtractionService } from './application/extraction.service';
import { OnboardingJobs } from './infra/onboarding.jobs';
import { OnboardingController, OnboardingReviewController } from './api/onboarding.controller';

/** SD-44 (core): questionnaire, uploads, review queue. */
@Module({
  imports: [AuthModule, StorageModule, SqsModule, EventsModule, JobsModule],
  providers: [OnboardingSessionService, OnboardingDocumentsService, VerificationService, ReviewService],
  exports: [VerificationService],
  controllers: [OnboardingController, OnboardingReviewController],
})
export class OnboardingModule {}

/**
 * SD-44 extraction (Lambda `document-extractor`, or any worker): no HTTP, no
 * auth stack - SecretBox is provided directly.
 */
@Module({
  imports: [LlmModule, StorageModule, EventsModule, JobsModule, KafkaProducerModule, ClickHouseModule],
  providers: [ExtractionService, VerificationService, LlmMeter, UsageService, SecretBox],
  exports: [ExtractionService],
})
export class OnboardingExtractionModule {}

/** SD-44 (worker): retention job. */
@Module({ imports: [StorageModule], providers: [OnboardingJobs] })
export class OnboardingWorkerModule {}
