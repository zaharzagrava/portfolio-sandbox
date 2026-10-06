import { Global, Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { DomainEventsService } from './domain-events.service';

@Global()
@Module({
  imports: [SequelizeModule.forFeature([Outbox])],
  providers: [DomainEventsService],
  exports: [DomainEventsService],
})
export class EventsModule {}
