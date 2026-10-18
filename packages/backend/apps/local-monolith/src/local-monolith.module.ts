import { Module } from '@nestjs/common';
import { CoreModule } from '@app/core/core.module';
import { BffAppModule } from '@app/bff/bff-app.module';
import { SseGatewayModule } from '@app/sse-gateway/sse-gateway.module';
import { WorkerModule } from '@app/worker/worker.module';
import { ProjectorModule } from '@app/projector/projector.module';
import { CollabAppModule } from '@app/collab/collab-app.module';
import { PublicApiAppModule } from '@app/public-api/public-api-app.module';
import { OnboardingLocalExtractorModule } from '@app/domains/seller-onboarding';

/**
 * One process with every app of the platform, plus the consumers that a deployed environment runs as Lambdas: the
 * document extractor (J02 G-11), so a stack started with `dev-monolith` decides onboarding documents from the first minute.
 */
@Module({
  imports: [
    CoreModule,
    BffAppModule,
    SseGatewayModule,
    WorkerModule,
    ProjectorModule,
    CollabAppModule,
    PublicApiAppModule,
    OnboardingLocalExtractorModule,
  ],
})
export class LocalMonolithModule {}
