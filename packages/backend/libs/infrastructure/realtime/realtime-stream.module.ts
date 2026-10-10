import { Module } from '@nestjs/common';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { RealtimeModule } from './realtime.module';
import { realtimeRatePolicies } from './realtime-rate-policies';
import { StreamAuthGuard } from './stream/stream-auth.guard';
import { StreamService } from './stream/stream.service';
import { TopicStreamController } from './stream/topic-stream.controller';

/** The SSE endpoint `GET /api/streams` and its engine; imported by the gateway app only (S51 FR-051). */
@Module({
  imports: [RealtimeModule, RateLimitModule.forFeature(realtimeRatePolicies)],
  providers: [StreamService, StreamAuthGuard],
  controllers: [TopicStreamController],
})
export class RealtimeStreamModule {}
