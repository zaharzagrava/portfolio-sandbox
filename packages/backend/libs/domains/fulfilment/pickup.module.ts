import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { PickupService } from './application/pickup.service';
import { AvailabilityIndex } from './infra/availability-index';
import { PickupController } from './api/pickup.controller';

/** SD-13 (core). */
@Module({
  imports: [AuthModule, ElasticsearchModule, EventsModule],
  providers: [PickupService, AvailabilityIndex],
  exports: [PickupService, AvailabilityIndex],
  controllers: [PickupController],
})
export class PickupModule {}
