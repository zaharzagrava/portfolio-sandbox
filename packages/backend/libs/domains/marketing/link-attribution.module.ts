import { Module } from '@nestjs/common';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { LinkAttributionService } from './application/link-attribution.service';
import { LINK_REPOSITORY } from './domain/ports';
import { DynamoLinkRepository } from './infra/dynamo-link.repository';

/**
 * The R1 attribution lookup alone (S37 FR-068, consumed by checkout in J05): the link store and the clock, without the
 * HTTP routes, the click pipeline or the Kafka producer, so a process that only resolves `ref` codes loads nothing else.
 */
@Module({
  imports: [ClockModule],
  providers: [
    DynamoLinkRepository,
    { provide: LINK_REPOSITORY, useExisting: DynamoLinkRepository },
    LinkAttributionService,
  ],
  exports: [LinkAttributionService],
})
export class LinkAttributionModule {}
