import { Module } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { LLM_PROVIDER } from './llm-provider';
import { AnthropicLlmProvider } from './anthropic.provider';
import { ScriptedLlmProvider } from './scripted.provider';

/** One provider instance per process (shared by the assistant, RAG answers and document extraction). No ANTHROPIC_API_KEY → scripted provider (local dev, e2e). */
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => {
        const key = config.get('anthropic_api_key');
        return key ? new AnthropicLlmProvider(key) : new ScriptedLlmProvider();
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
