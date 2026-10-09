import { Module } from '@nestjs/common';
import { EventsModule } from '../events.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { FixtureService } from './fixture.service';

/**
 * Test code only (S53 test-plan): the `fixtures` aggregate with its tenant-scoped table, events and services.
 * Later tasks add consumers, HTTP routes and sinks here. Imports no domain (X.5).
 */
@Module({
  imports: [EventsModule, OutboxModule],
  providers: [FixtureService],
  exports: [FixtureService],
})
export class FixturesModule {}
