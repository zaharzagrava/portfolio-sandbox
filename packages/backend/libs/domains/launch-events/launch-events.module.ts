import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import LaunchEvent from './infra/models/launch-event.model';
import Booking from './infra/models/booking.model';
import { AuthModule } from '@app/domains/identity';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { WaitingRoomService } from './application/waiting-room.service';
import { SeatHoldService } from './application/seat-hold.service';
import { LaunchEventsController } from './api/launch-events.controller';

/** SD-21 HTTP side (core). Needs global Redis, Dynamo, Cache modules. */
@Module({
  imports: [
    AuthModule,
    JobsModule,
    RealtimeModule,
    SequelizeModule.forFeature([LaunchEvent, Booking]),
  ],
  providers: [WaitingRoomService, SeatHoldService],
  exports: [WaitingRoomService, SeatHoldService],
  controllers: [LaunchEventsController],
})
export class LaunchEventsModule {}
