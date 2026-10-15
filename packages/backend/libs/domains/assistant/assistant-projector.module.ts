import { Module, Type } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import type { Projector } from '@app/infrastructure/projections/projector';
import { LlmCallsProjector } from './infra/llm-calls.projector';

/**
 * S46 (apps/projector): the `llm-calls-log` projector that stores every `llm.call_completed` record in ClickHouse
 * `llm_requests`. It needs only ClickHouse, so the module boots on its own in the projector app (no assistant, billing
 * or catalog module comes with it). The app lists `AssistantProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject.
 */
@Module({
  imports: [ClickHouseModule],
  providers: [LlmCallsProjector],
  // The projector runtime instantiates the listed projectors itself: what they inject must come out of this module.
  exports: [LlmCallsProjector, ClickHouseModule],
})
export class AssistantProjectorModule {
  static readonly projectors: Type<Projector>[] = [LlmCallsProjector];
}
