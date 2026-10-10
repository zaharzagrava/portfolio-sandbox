import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import LaunchEvent from './infra/models/launch-event.model';
import Booking from './infra/models/booking.model';
import { AuthModule } from '@app/domains/identity';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { WaitingRoomService } from './application/waiting-room.service';
import { SeatHoldService } from './application/seat-hold.service';
import { AdmissionTicker } from './infra/admission-ticker.service';

/** SD-21 background side (apps/worker): admission ticker + hold expiry. */
@Module({
  imports: [
    AuthModule,
    RealtimeModule,
    DynamoModule,
    SequelizeModule.forFeature([LaunchEvent, Booking]),
  ],
  providers: [WaitingRoomService, SeatHoldService, AdmissionTicker],
})
export class LaunchEventsWorkerModule {}
