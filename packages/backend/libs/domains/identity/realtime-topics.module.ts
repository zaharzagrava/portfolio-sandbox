import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { AuthModule } from './auth.module';
import { IdentityStreamAuthenticator } from './api/realtime-authenticator';
import { IdentityTopics } from './api/realtime-topics';

/** Registers this domain's realtime topics and the stream credential check in the SSE gateway (imported there; debt D-3). */
@Module({
  imports: [RealtimeModule, AuthModule],
  providers: [IdentityTopics, IdentityStreamAuthenticator],
})
export class IdentityTopicsModule {}
