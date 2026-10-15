import { Module } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { AnthropicLlmProvider } from './anthropic.provider';
import { assertLlmConfig, LlmConfig } from './llm-config';
import { LlmCallRecorder } from './llm-call-recorder';
import { LLM_PROVIDER } from './llm-provider';
import { ScriptedLlmProvider } from './scripted.provider';

/** The validated `LlmConfig` of this process (a violation fails startup naming the key, AS-74). */
export const LLM_CONFIG = Symbol('LLM_CONFIG');

/**
 * One provider instance per process (shared by the assistant, RAG answers and document extraction), plus the recorder
 * that appends `llm.call_completed` through the outbox. The provider is the scripted one only when `llm_provider` is set
 * to `scripted` outside production; a missing key never selects it.
 */
@Module({
  imports: [
    EventsModule.forAggregates([
      { aggregateType: 'llm', retention: 'full-history' },
    ]),
  ],
  providers: [
    {
      provide: LLM_CONFIG,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService): LlmConfig =>
        assertLlmConfig(
          (key) => config.get(key as never),
          config.get('node_env') === 'production',
        ),
    },
    {
      provide: LLM_PROVIDER,
      inject: [LLM_CONFIG],
      useFactory: (config: LlmConfig) =>
        config.llm_provider === 'scripted'
          ? new ScriptedLlmProvider()
          : new AnthropicLlmProvider(config.anthropic_api_key!),
    },
    LlmCallRecorder,
  ],
  exports: [LLM_PROVIDER, LLM_CONFIG, LlmCallRecorder],
})
export class LlmModule {}
