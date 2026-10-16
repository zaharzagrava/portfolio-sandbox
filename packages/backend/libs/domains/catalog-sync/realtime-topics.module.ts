import { Module } from '@nestjs/common';
import { TenancyModule } from '@app/domains/tenancy';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { ImportJobTopics } from './api/realtime-topics';

/** Registers the live topic `import:<id>` in the SSE gateway (imported there; S51). */
@Module({
  imports: [RealtimeModule, TenancyModule],
  providers: [ImportJobTopics],
})
export class ImportJobTopicsModule {}
