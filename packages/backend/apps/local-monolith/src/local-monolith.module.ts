import { Module } from '@nestjs/common';
import { CoreModule } from '@app/core/core.module';
import { BffAppModule } from '@app/bff/bff-app.module';
import { SseGatewayModule } from '@app/sse-gateway/sse-gateway.module';
import { WorkerModule } from '@app/worker/worker.module';
import { ProjectorModule } from '@app/projector/projector.module';
import { CollabAppModule } from '@app/collab/collab-app.module';
import { PublicApiAppModule } from '@app/public-api/public-api-app.module';

@Module({
  imports: [
    CoreModule,
    BffAppModule,
    SseGatewayModule,
    WorkerModule,
    ProjectorModule,
    CollabAppModule,
    PublicApiAppModule,
  ],
})
export class LocalMonolithModule {}
