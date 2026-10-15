import { Injectable } from '@nestjs/common';
import { LlmCallRecorder } from '@app/infrastructure/llm';
import type { CallRecord, CallRecorder } from '../domain/ports';

/**
 * S47 `CallRecorder` port over S46's `LlmCallRecorder` (purpose `rag`, metric `llm.rag.tokens`): every attempted model
 * call, failed, refused and aborted ones included, becomes one `llm.call_completed` outbox record that billing (S18)
 * consumes. The recorder never throws, so metering cannot fail a user-facing call.
 */
@Injectable()
export class CallRecorderAdapter implements CallRecorder {
  constructor(private readonly recorder: LlmCallRecorder) {}

  async record(call: CallRecord): Promise<void> {
    await this.recorder.record({
      subjectId: call.subjectId,
      scopeId: call.scopeId,
      callId: call.callId,
      purpose: 'rag',
      metric: 'llm.rag.tokens',
      requestedModel: call.requestedModel,
      outcome: call.outcome,
      result: {
        model: call.model,
        usage: call.usage,
        stopReason: call.stopReason,
      },
      ttftMs: call.ttftMs,
      durationMs: call.durationMs,
      usageEstimated: call.usageEstimated,
    });
  }
}
