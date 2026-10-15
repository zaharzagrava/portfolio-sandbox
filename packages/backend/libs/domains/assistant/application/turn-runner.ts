import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  estimateTokens,
  LLM_PROVIDER,
  LlmAbortedError,
  LlmRejectedError,
  LlmUnavailableError,
  textOf,
  type LlmProvider,
  type LlmResult,
} from '@app/infrastructure/llm';
import {
  ADMISSION_STORE,
  CONVERSATION_REPOSITORY,
  GENERATION_STORE,
  MODERATION_PORT,
  TOOL_CATALOG,
  type AdmissionStore,
  type ConversationRecord,
  type ConversationRepository,
  type GenerationEvent,
  type GenerationStore,
  type MessageRecord,
  type ModerationPort,
  type NewMessage,
  type ToolCatalog,
} from '../domain/assistant-ports';
import { decideCompaction } from '../domain/compaction';
import type { GenerationErrorCode } from '../domain/generation-state';
import { OutputWindow } from '../domain/output-window';
import { TextCoalescer } from '../domain/text-coalescer';
import { ModerationUnavailableError } from './assistant-errors';
import { assistantToolCalls } from './assistant-metrics';
import { ASSISTANT_SYSTEM, SUMMARY_SYSTEM } from './assistant.prompt';
import { ASSISTANT_TOOLS } from './assistant-tools';
import { AllowanceService } from './allowance.service';
import { AllModelsBlockedError, ModelRouter } from './model-router';
import { MeteringService, ZERO_USAGE } from './metering.service';
import { logIds } from './turn-log';

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** Model calls per user message that carry tools; the last one runs with tool use forbidden (AS-17). */
export const MAX_ROUNDS = 5;
const MAX_OUTPUT_TOKENS = 16_000;

export type AbortReason =
  'cancel' | 'detached' | 'timeout' | 'shutdown' | 'moderation';

/** What the generation service hands the runner: the abort signal and why it fired. */
export interface TurnControl {
  signal: AbortSignal;
  abort(reason: AbortReason): void;
  reason(): AbortReason | null;
}

export interface TurnJob {
  userId: string;
  conversation: ConversationRecord;
  messageId: string;
  text: string;
  location: { lat: number; lng: number } | null;
  /** Of the request that started the turn; every log line about the turn carries it. */
  requestId?: string;
}

/** The terminal event a turn ended with and whether it was persisted. */
export interface TurnOutcome {
  event: Extract<GenerationEvent, { type: 'done' | 'refusal' | 'error' }>;
  label: string;
}

interface RunState {
  pending: Promise<unknown>[];
  persisted: NewMessage[];
  flagged: ModerationFlagged | null;
  moderationDown: boolean;
}

class ToolLoopLimitError extends Error {}
class SummaryFailedError extends Error {}
class ModerationFlagged extends Error {
  constructor(readonly category: string) {
    super('flagged');
  }
}

const summaryMessage = (summary: string): MessageParam => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: `<conversation_summary>\n${summary}\n</conversation_summary>`,
    },
  ],
});

const toParam = (m: MessageRecord): MessageParam => ({
  role: m.role,
  content: JSON.parse(m.content),
});

const blocksOf = (content: MessageParam['content']) =>
  typeof content === 'string'
    ? [{ type: 'text', text: content } as Anthropic.Beta.BetaContentBlockParam]
    : content;

const toNew = (
  message: MessageParam,
  visibleText: string,
  toolNames: string[],
): NewMessage => ({
  role: message.role as 'user' | 'assistant',
  content: JSON.stringify(message.content),
  visibleText,
  toolNames,
});

/**
 * One turn, from the first event to the terminal one (S46 US1..US7). The model-and-tool loop streams into the generation
 * store; the whole turn is written to the transcript only when it ends `done`; every other outcome leaves no row. The
 * conversation lock and the user's slot are released before the terminal event is appended.
 */
@Injectable()
export class TurnRunner {
  private readonly logger = new Logger(TurnRunner.name);

  constructor(
    @Inject(GENERATION_STORE) private readonly store: GenerationStore,
    @Inject(CONVERSATION_REPOSITORY)
    private readonly conversations: ConversationRepository,
    @Inject(ADMISSION_STORE) private readonly admission: AdmissionStore,
    @Inject(MODERATION_PORT) private readonly moderation: ModerationPort,
    @Inject(TOOL_CATALOG) private readonly tools: ToolCatalog,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly router: ModelRouter,
    private readonly metering: MeteringService,
    private readonly allowance: AllowanceService,
    private readonly config: ApiConfigService,
  ) {}

  async run(job: TurnJob, control: TurnControl): Promise<TurnOutcome> {
    const state: RunState = {
      pending: [],
      persisted: [],
      flagged: null,
      moderationDown: false,
    };
    let outcome: TurnOutcome;
    try {
      outcome = await this.loop(job, control, state);
    } catch (error) {
      outcome = this.failure(
        job,
        control,
        error,
        state.flagged,
        state.moderationDown,
      );
    }
    return this.finish(job, outcome, state.persisted, state.pending);
  }

  private async loop(
    job: TurnJob,
    control: TurnControl,
    state: RunState,
  ): Promise<TurnOutcome> {
    const { userId, messageId } = job;
    const conversationId = job.conversation.conversationId;
    const { pending, persisted } = state;
    let calls = 0;
    const totals = { inputTokens: 0, outputTokens: 0 };
    let publishChain: Promise<void> = Promise.resolve();

    const publish = (event: GenerationEvent) =>
      this.store.append(userId, messageId, event);

    {
      await publish({ type: 'meta', data: { messageId, conversationId } });
      const history = await this.prepareHistory(job, control, pending);

      const userMessage: MessageParam = {
        role: 'user',
        content: [
          { type: 'text', text: job.text },
          {
            type: 'text',
            text: `<context>Location shared for pickup search: ${job.location ? 'yes' : 'no'}.</context>`,
          },
        ],
      };
      persisted.push(toNew(userMessage, job.text, []));
      const messages: MessageParam[] = [...history, userMessage];

      // Output is moderated chunk by chunk (with the 256 characters before it) before it is published.
      const window = new OutputWindow();
      const coalescer = () =>
        new TextCoalescer(
          (chunk) => {
            publishChain = publishChain.then(async () => {
              if (state.flagged || state.moderationDown) return;
              try {
                const verdict = await this.moderation.checkOutput(
                  chunk,
                  window.context(),
                );
                if (verdict.flagged) {
                  state.flagged = new ModerationFlagged(verdict.category);
                  control.abort('moderation');
                  return;
                }
              } catch (error) {
                if (!(error instanceof ModerationUnavailableError)) throw error;
                state.moderationDown = true;
                control.abort('moderation');
                return;
              }
              window.accept(chunk);
              await publish({ type: 'text', data: { t: chunk } });
            });
          },
          { clock: this.clock },
        );

      for (let round = 1; ; round++) {
        if (control.signal.aborted) throw new LlmAbortedError();
        const lastRound = round >= MAX_ROUNDS;
        const text = coalescer();
        let result: LlmResult;
        try {
          result = await this.router.stream({
            turn: {
              userId,
              conversationId,
              messageId,
              requestId: job.requestId,
            },
            request: {
              system: ASSISTANT_SYSTEM,
              tools: ASSISTANT_TOOLS,
              messages,
              maxTokens: MAX_OUTPUT_TOKENS,
              effort: this.config.get('assistant_effort'),
              toolsDisabled: lastRound,
            },
            signal: control.signal,
            onText: (d) => text.push(d),
            nextCall: () => ++calls,
            track: (p) => pending.push(p),
          });
        } catch (error) {
          text.discard();
          await publishChain.catch(() => undefined);
          throw error;
        }
        text.flush();
        await publishChain;
        if (state.flagged || state.moderationDown) throw new LlmAbortedError();
        totals.inputTokens += result.usage.inputTokens;
        totals.outputTokens += result.usage.outputTokens;

        if (result.stopReason === 'refusal') {
          return {
            event: {
              type: 'refusal',
              data: {
                category: result.refusalCategory ?? 'unspecified',
                source: 'provider',
              },
            },
            label: 'refusal',
          };
        }

        const assistant: MessageParam = {
          role: 'assistant',
          content: result.content as Anthropic.Beta.BetaContentBlockParam[],
        };
        const toolUses = result.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
        );
        const visible = textOf(result.content);
        const names = toolUses.map((t) => t.name);

        if (result.stopReason === 'tool_use' && toolUses.length) {
          if (lastRound) throw new ToolLoopLimitError();
          const results = await this.runTools(
            job,
            toolUses,
            control,
            `${messageId}:${calls}`,
          );
          const resultMessage: MessageParam = {
            role: 'user',
            content: results,
          };
          persisted.push(
            toNew(assistant, visible, names),
            toNew(resultMessage, '', []),
          );
          messages.push(assistant, resultMessage);
          continue;
        }
        if (result.stopReason === 'max_tokens' && toolUses.length) {
          // A cut-off tool input can still parse; it is never run.
          throw new Error('tool input truncated');
        }
        persisted.push(toNew(assistant, visible, names));
        if (result.stopReason === 'pause_turn') {
          if (lastRound) throw new ToolLoopLimitError();
          messages.push(assistant);
          continue;
        }
        return {
          event: {
            type: 'done',
            data: {
              stopReason: result.stopReason ?? 'end_turn',
              truncated: result.stopReason === 'max_tokens',
              usage: totals,
              allowance: { used: 0, limit: 0 },
            },
          },
          label: 'done',
        };
      }
    }
  }

  /**
   * Waits for the metering of every call, persists a `done` turn in one batch, frees the lock and the slot, and only
   * then appends the terminal event (AS-31).
   */
  private async finish(
    job: TurnJob,
    outcome: TurnOutcome,
    persisted: NewMessage[],
    pending: Promise<unknown>[],
  ): Promise<TurnOutcome> {
    const { userId, messageId } = job;
    const conversationId = job.conversation.conversationId;
    let final: TurnOutcome = outcome;
    await Promise.allSettled(pending);
    try {
      if (final.event.type === 'done') {
        await this.conversations.appendTurn(
          userId,
          conversationId,
          messageId,
          persisted,
        );
        const snapshot = await this.allowance.current(userId).catch(() => null);
        final.event.data.allowance = {
          used: snapshot?.used ?? 0,
          limit: snapshot?.limit ?? 0,
        };
      }
    } catch {
      this.logger.error(`turn could not be persisted ${this.ids(job)}`);
      final = {
        event: { type: 'error', data: { code: 'INTERNAL' } },
        label: 'internal',
      };
    }
    await this.admission
      .releaseLock(userId, conversationId, messageId)
      .catch(() => undefined);
    await this.admission.releaseSlot(userId, messageId).catch(() => undefined);
    await this.store
      .finish(userId, messageId, final.event)
      .catch(() =>
        this.logger.warn(`terminal event could not be stored ${this.ids(job)}`),
      );
    return final;
  }

  private ids(job: TurnJob, callId?: string): string {
    return logIds({
      requestId: job.requestId,
      conversationId: job.conversation.conversationId,
      messageId: job.messageId,
      callId,
    });
  }

  private failure(
    job: TurnJob,
    control: TurnControl,
    error: unknown,
    flagged: ModerationFlagged | null,
    moderationDown: boolean,
  ): TurnOutcome {
    const code = (
      c: GenerationErrorCode,
      retryAfterMs?: number,
    ): TurnOutcome => ({
      event: {
        type: 'error',
        data: { code: c, ...(retryAfterMs !== undefined && { retryAfterMs }) },
      },
      label: c.toLowerCase(),
    });
    if (flagged)
      return {
        event: {
          type: 'refusal',
          data: { category: flagged.category, source: 'moderation' },
        },
        label: 'refusal',
      };
    if (moderationDown) {
      this.logger.warn(
        `moderation unavailable during the reply ${this.ids(job)}`,
      );
      return code('MODERATION_UNAVAILABLE');
    }
    if (error instanceof LlmAbortedError) {
      switch (control.reason()) {
        case 'timeout':
          return code('TURN_TIMEOUT');
        case 'shutdown':
          return code('SHUTTING_DOWN');
        default:
          return code('CANCELLED');
      }
    }
    if (error instanceof AllModelsBlockedError)
      return code('PROVIDER_UNAVAILABLE', error.retryAfterMs);
    if (
      error instanceof LlmUnavailableError ||
      error instanceof SummaryFailedError
    )
      return code(
        'PROVIDER_UNAVAILABLE',
        error instanceof LlmUnavailableError
          ? (error.retryAfterMs ?? undefined)
          : undefined,
      );
    if (error instanceof ToolLoopLimitError) return code('TOOL_LOOP_LIMIT');
    if (error instanceof LlmRejectedError) {
      this.logger.error(
        `provider rejected a call (status ${error.status}) ${this.ids(job)}`,
      );
      return code('INTERNAL');
    }
    // Code only: the message of an unexpected error may carry user text.
    this.logger.error(
      `turn failed (${(error as Error)?.name ?? 'error'}) ${this.ids(job)}`,
    );
    return code('INTERNAL');
  }

  /** Parallel tool calls run concurrently; all results go back in one message, in call order. */
  private async runTools(
    job: TurnJob,
    toolUses: Anthropic.Beta.BetaToolUseBlock[],
    control: TurnControl,
    callId: string,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam[]> {
    const { userId, messageId } = job;
    for (const t of toolUses)
      await this.store.append(userId, messageId, {
        type: 'tool',
        data: { id: t.id, name: t.name, status: 'running' },
      });
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new LlmAbortedError());
      if (control.signal.aborted) fail();
      else control.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);
    const run = Promise.all(
      toolUses.map(async (t) => {
        const result = await this.tools.execute(t.name, t.input, {
          messageId,
          requestId: job.requestId,
          callId,
          userId,
          conversationId: job.conversation.conversationId,
          signal: control.signal,
          ...(job.location && { location: job.location }),
        });
        assistantToolCalls.add(1, {
          tool: t.name,
          outcome: result.ok ? 'ok' : 'error',
        });
        await this.store.append(userId, messageId, {
          type: 'tool',
          data: {
            id: t.id,
            name: t.name,
            status: result.ok ? 'done' : 'failed',
          },
        });
        return {
          type: 'tool_result' as const,
          tool_use_id: t.id,
          content: result.ok ? JSON.stringify(result.content) : result.error,
          ...(!result.ok && { is_error: true }),
        };
      }),
    );
    return Promise.race([run, aborted]);
  }

  /** Summary (if any) plus everything after it; compacts first when the replayed history has grown too large. */
  private async prepareHistory(
    job: TurnJob,
    control: TurnControl,
    pending: Promise<unknown>[],
  ): Promise<MessageParam[]> {
    const { conversation, userId } = job;
    const stored = await this.conversations.messages(
      userId,
      conversation.conversationId,
      conversation.compactedUpTo
        ? { afterMessageId: conversation.compactedUpTo }
        : {},
    );
    const history: MessageParam[] = [
      ...(conversation.summary ? [summaryMessage(conversation.summary)] : []),
      ...stored.map(toParam),
    ];
    if (!stored.length) return history;

    const model = this.config.get('assistant_model');
    const decision = await decideCompaction(
      estimateTokens(
        JSON.stringify([ASSISTANT_SYSTEM, ASSISTANT_TOOLS, history]).length,
      ),
      () =>
        this.llm.countTokens({
          model,
          system: ASSISTANT_SYSTEM,
          tools: ASSISTANT_TOOLS,
          messages: history,
        }),
    );
    if (!decision.compact) return history;

    const summary = await this.summarise(job, history, control, pending);
    await this.conversations.recordCompaction(
      userId,
      conversation.conversationId,
      summary,
      stored[stored.length - 1].messageId,
    );
    return [summaryMessage(summary)];
  }

  private async summarise(
    job: TurnJob,
    history: MessageParam[],
    control: TurnControl,
    pending: Promise<unknown>[],
  ): Promise<string> {
    // Visible text and tool names only: the summariser is another model and cannot read thinking blocks anyway.
    const transcript = history
      .map((m) => {
        const parts = blocksOf(m.content)
          .map((b) =>
            b.type === 'text'
              ? b.text
              : b.type === 'tool_use'
                ? `[looked up ${b.name}]`
                : '',
          )
          .filter(Boolean);
        return parts.length
          ? `${m.role.toUpperCase()}: ${parts.join(' ')}`
          : '';
      })
      .filter(Boolean)
      .join('\n\n');
    const model = this.config.get('assistant_summary_model');
    const turn = {
      userId: job.userId,
      conversationId: job.conversation.conversationId,
      messageId: job.messageId,
      requestId: job.requestId,
    };
    const started = Date.now();
    try {
      const result = await this.llm.complete(
        {
          model,
          system: SUMMARY_SYSTEM,
          tools: [],
          messages: [
            {
              role: 'user',
              content: `<transcript>\n${transcript}\n</transcript>`,
            },
          ],
          maxTokens: 2_000,
          timeoutMs: this.config.get('assistant_call_timeout_ms'),
        },
        control.signal,
      );
      pending.push(
        this.metering.recordCall(turn, {
          n: 0,
          purpose: 'summary',
          requestedModel: model,
          model: result.model,
          outcome: 'completed',
          usage: result.usage,
          stopReason: result.stopReason,
          ttftMs: null,
          durationMs: Date.now() - started,
          usageEstimated: false,
        }),
      );
      return textOf(result.content);
    } catch (error) {
      pending.push(
        this.metering.recordCall(turn, {
          n: 0,
          purpose: 'summary',
          requestedModel: model,
          model,
          outcome: error instanceof LlmAbortedError ? 'aborted' : 'failed',
          usage: ZERO_USAGE,
          stopReason: null,
          ttftMs: null,
          durationMs: Date.now() - started,
          usageEstimated: false,
        }),
      );
      if (error instanceof LlmAbortedError) throw error;
      throw new SummaryFailedError();
    }
  }
}
