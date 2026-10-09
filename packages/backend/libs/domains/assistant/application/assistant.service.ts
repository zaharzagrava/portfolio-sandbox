import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { types } from 'cassandra-driver';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  ConversationRow,
  ConversationStore,
  MAX_MESSAGES,
  StoredMessage,
} from '../infra/conversation.store';
import {
  GenerationBuffer,
  GenerationEventType,
} from '../infra/generation-buffer';
import {
  ASSISTANT_TOOLS,
  AssistantToolExecutor,
  ToolContext,
} from './assistant-tools';
import { AssistantQuotaService } from './assistant-quota.service';
import { ASSISTANT_SYSTEM, SUMMARY_SYSTEM } from './assistant.prompt';
import { LlmMeter } from '../infra/llm/llm-meter';
import {
  Domain_AssistantTurnInProgress,
  Domain_ConversationFull,
} from './assistant-errors';
import {
  LLM_PROVIDER,
  LlmAbortedError,
  LlmTurnRequest,
  LlmTurnResult,
  LlmUnavailableError,
  textOf,
} from '../infra/llm/llm-provider';
import type { LlmProvider } from '../infra/llm/llm-provider';
import { costMicros, estimateTokens } from '../infra/llm/pricing';

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** Tool rounds per user message; the last allowed round runs with tools disabled so it must answer. */
const MAX_TOOL_ROUNDS = 5;
const MAX_OUTPUT_TOKENS = 16_000;
/** History size (tokens) that triggers compaction at the start of a turn. */
const COMPACT_AT_TOKENS = 60_000;
/** Turn lock outlives any healthy turn; a crashed instance's lock frees itself. */
const TURN_LOCK_MS = 5 * 60_000;
const OUTPUT_ALLOWANCE_FOR_BUDGET = 2_000;

/** Marks the per-turn facts block appended to user messages (hidden from the UI history). */
const CONTEXT_TAG = '<context>';
const RELEASE_IF_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const turnLockKey = (conversationId: string) =>
  `assistant:turn:{${conversationId}}`;

export interface TurnInput {
  text: string;
  location: ToolContext['location'];
}

interface TurnContext {
  userId: string;
  conversation: ConversationRow;
  messageId: string;
  input: TurnInput;
}

/**
 * SD-42 shopping assistant. A turn = validate + lock + budget synchronously
 * (so 404/409/429 are plain HTTP errors), then generate in the background
 * into the GenerationBuffer; the HTTP response is just a viewer of it.
 *
 * History rules (prompt caching + preserved thinking): the transcript is
 * append-only and replayed byte-for-byte, assistant turns verbatim with their
 * thinking blocks; system prompt and tools never change. When it grows too
 * long it is replaced by ONE summary ("simple compaction") and nothing before
 * it is replayed again.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly summaryModel: string;
  private readonly effort: NonNullable<LlmTurnRequest['effort']>;

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly store: ConversationStore,
    private readonly buffer: GenerationBuffer,
    private readonly tools: AssistantToolExecutor,
    private readonly quota: AssistantQuotaService,
    private readonly meterSvc: LlmMeter,
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {
    this.model = config.get('assistant_model') ?? 'claude-opus-5-5';
    this.fallbackModel =
      config.get('assistant_fallback_model') ?? 'claude-sonnet-5-5';
    this.summaryModel =
      config.get('assistant_summary_model') ?? 'claude-haiku-4-5';
    this.effort = config.get('assistant_effort') ?? 'low';
  }

  private get detachGraceMs() {
    return Number(this.config.get('assistant_detach_grace_ms') ?? 10_000);
  }

  createConversation(userId: string, title?: string) {
    return this.store.create(userId, (title ?? 'New chat').slice(0, 120));
  }

  listConversations(userId: string) {
    return this.store.list(userId);
  }

  /** What the UI renders: text and which tools ran - never thinking blocks or raw tool output. */
  async history(userId: string, conversationId: string) {
    const conversation = await this.store.get(userId, conversationId);
    const messages = await this.store.messages(conversationId);
    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
      },
      messages: messages
        .map((m) => ({
          id: m.id,
          turnId: m.turnId,
          role: m.role,
          text: m.content
            .map((b) =>
              b.type === 'text' && !b.text.startsWith(CONTEXT_TAG)
                ? b.text
                : '',
            )
            .join(''),
          tools: m.content
            .filter(
              (b): b is Anthropic.Beta.BetaToolUseBlockParam =>
                b.type === 'tool_use',
            )
            .map((b) => b.name),
        }))
        .filter((m) => m.text || m.tools.length),
    };
  }

  async startTurn(
    userId: string,
    conversationId: string,
    input: TurnInput,
  ): Promise<{ messageId: string }> {
    const conversation = await this.store.get(userId, conversationId);
    if (
      (await this.store.count(conversationId)) >=
      MAX_MESSAGES - 2 * MAX_TOOL_ROUNDS - 2
    ) {
      throw new Domain_ConversationFull();
    }
    await this.quota.assertMonthly(userId);

    const messageId = types.TimeUuid.now().toString();
    const locked = await this.redis.client.set(
      turnLockKey(conversationId),
      messageId,
      'PX',
      TURN_LOCK_MS,
      'NX',
    );
    if (!locked) throw new Domain_AssistantTurnInProgress();

    try {
      // Rough size of what we're about to send; the precise count happens only near the compaction threshold.
      await this.quota.takeProviderBudget(
        this.model,
        estimateTokens([ASSISTANT_SYSTEM, ASSISTANT_TOOLS, input.text]) +
          COMPACT_AT_TOKENS / 4 +
          OUTPUT_ALLOWANCE_FOR_BUDGET,
      );
      await this.buffer.open(messageId, { userId, conversationId });
    } catch (error) {
      await this.releaseLock(conversationId, messageId);
      throw error;
    }

    void this.generate({ userId, conversation, messageId, input });
    return { messageId };
  }

  async cancel(userId: string, messageId: string): Promise<boolean> {
    const owner = await this.buffer.owner(messageId);
    if (owner?.userId !== userId) return false;
    await this.buffer.requestCancel(messageId);
    return true;
  }

  private async generate(turn: TurnContext): Promise<void> {
    const { userId, conversation, messageId } = turn;
    const controller = new AbortController();
    const stopWatching = this.watchViewers(messageId, controller);
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 0,
    };
    let terminal: [GenerationEventType, Record<string, unknown>] = [
      'error',
      { code: 'INTERNAL' },
    ];

    try {
      await this.buffer.append(messageId, 'meta', {
        messageId,
        conversationId: conversation.id,
      });
      const history = await this.prepareHistory(turn, controller.signal);

      const userMessage: MessageParam = {
        role: 'user',
        content: this.userContent(turn.input),
      };
      await this.store.append(conversation.id, messageId, [
        userMessage as StoredMessage,
      ]);
      const messages = [...history, userMessage];

      const text = new TextCoalescer((t) =>
        this.buffer.append(messageId, 'text', { t }),
      );
      for (let round = 1; ; round++) {
        if (round > MAX_TOOL_ROUNDS + 1)
          throw new Error('tool loop did not terminate');
        const result = await this.callModel(
          turn,
          messages,
          round >= MAX_TOOL_ROUNDS,
          controller.signal,
          (d) => text.push(d),
        );
        await text.flush();
        this.addTotals(totals, result);

        if (result.stopReason === 'refusal') {
          // Not persisted: the declined output never becomes history.
          terminal = ['refusal', { category: result.refusalCategory }];
          return;
        }

        const assistant: MessageParam = {
          role: 'assistant',
          content: result.content,
        };
        const toolUses = result.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
        );

        if (result.stopReason === 'tool_use' && toolUses.length) {
          const toolResults = await this.runTools(
            messageId,
            toolUses,
            turn.input.location,
          );
          const results: MessageParam = { role: 'user', content: toolResults };
          // Same-partition batch: a tool_use is never stored without its tool_result.
          await this.store.append(conversation.id, messageId, [
            assistant,
            results,
          ] as StoredMessage[]);
          messages.push(assistant, results);
          continue;
        }
        if (result.stopReason === 'max_tokens' && toolUses.length) {
          // A cut-off tool input can still parse; never run it.
          throw new Error('tool input truncated at max_tokens');
        }
        await this.store.append(conversation.id, messageId, [
          assistant as StoredMessage,
        ]);
        if (result.stopReason === 'pause_turn') {
          messages.push(assistant);
          continue;
        }
        terminal = [
          'done',
          {
            stopReason: result.stopReason,
            truncated: result.stopReason === 'max_tokens',
            usage: totals,
          },
        ];
        return;
      }
    } catch (error) {
      if (error instanceof LlmAbortedError)
        terminal = ['error', { code: 'CANCELLED' }];
      else if (error instanceof LlmUnavailableError)
        terminal = [
          'error',
          { code: 'PROVIDER_UNAVAILABLE', retryAfterMs: error.retryAfterMs },
        ];
      else
        this.logger.error(
          `assistant turn ${messageId} failed: ${(error as Error).stack}`,
        );
    } finally {
      stopWatching();
      // Unlock BEFORE the terminal event: a client that sends its next message the moment it sees `done` must not get 409.
      await this.releaseLock(conversation.id, messageId).catch(() => undefined);
      await this.store.touch(userId, conversation.id).catch(() => undefined);
      await this.buffer
        .append(messageId, ...terminal)
        .catch((e) => this.logger.warn(`terminal event lost: ${e.message}`));
      await this.buffer.close(messageId).catch(() => undefined);
    }
  }

  /** Primary model; on overload/rate-limit BEFORE any text was streamed, one retry on the fallback model. */
  private async callModel(
    turn: TurnContext,
    messages: MessageParam[],
    lastRound: boolean,
    signal: AbortSignal,
    onText: (d: string) => void,
  ): Promise<LlmTurnResult> {
    const request = (model: string): LlmTurnRequest => ({
      model,
      system: ASSISTANT_SYSTEM,
      tools: ASSISTANT_TOOLS,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
      effort: this.effort,
      toolsDisabled: lastRound,
    });
    let streamed = false;
    const run = async (model: string) => {
      const started = Date.now();
      let ttftMs: number | null = null;
      const result = await this.llm.streamTurn(request(model), {
        signal,
        onText: (d) => {
          streamed = true;
          ttftMs ??= Date.now() - started;
          onText(d);
        },
      });
      await this.meter(
        turn,
        'chat',
        model,
        result,
        ttftMs,
        Date.now() - started,
      );
      return result;
    };
    try {
      return await run(this.model);
    } catch (error) {
      if (
        !(error instanceof LlmUnavailableError) ||
        streamed ||
        this.fallbackModel === this.model
      )
        throw error;
      this.logger.warn(
        `assistant: ${this.model} unavailable (${error.message}), falling back to ${this.fallbackModel}`,
      );
      return run(this.fallbackModel);
    }
  }

  private async runTools(
    messageId: string,
    toolUses: Anthropic.Beta.BetaToolUseBlock[],
    location: ToolContext['location'],
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam[]> {
    // Parallel calls run concurrently; ALL results go back in ONE user message.
    return Promise.all(
      toolUses.map(async (t) => {
        await this.buffer.append(messageId, 'tool', {
          id: t.id,
          name: t.name,
          status: 'running',
        });
        const outcome = await this.tools.run(t.name, t.input, { location });
        await this.buffer.append(messageId, 'tool', {
          id: t.id,
          name: t.name,
          status: outcome.isError ? 'failed' : 'done',
        });
        return {
          type: 'tool_result' as const,
          tool_use_id: t.id,
          content: outcome.content,
          ...(outcome.isError && { is_error: true }),
        };
      }),
    );
  }

  /** Summary (if any) + everything after it. Compacts first when the replayed history has grown too large. */
  private async prepareHistory(
    turn: TurnContext,
    signal: AbortSignal,
  ): Promise<MessageParam[]> {
    const { conversation } = turn;
    const stored = await this.store.messages(
      conversation.id,
      conversation.compactedUpto,
    );
    const history = [
      ...(conversation.summary ? [summaryMessage(conversation.summary)] : []),
      ...stored.map(toParam),
    ];
    if (!stored.length) return history;

    let size = estimateTokens([ASSISTANT_SYSTEM, ASSISTANT_TOOLS, history]);
    if (size > COMPACT_AT_TOKENS * 0.8) {
      size = await this.llm
        .countTokens({
          model: this.model,
          system: ASSISTANT_SYSTEM,
          tools: ASSISTANT_TOOLS,
          messages: history,
        })
        .catch(() => size);
    }
    if (size <= COMPACT_AT_TOKENS) return history;

    const summary = await this.summarise(turn, history, signal);
    await this.store.compact(
      turn.userId,
      conversation.id,
      summary,
      stored[stored.length - 1].id,
    );
    return [summaryMessage(summary)];
  }

  private async summarise(
    turn: TurnContext,
    history: MessageParam[],
    signal: AbortSignal,
  ): Promise<string> {
    // Visible text only: the summariser is a different model and can't read the main model's thinking anyway.
    const transcript = history
      .map((m) => {
        const blocks =
          typeof m.content === 'string'
            ? [{ type: 'text', text: m.content } as const]
            : m.content;
        const parts = blocks
          .map((b) =>
            b.type === 'text'
              ? b.text
              : b.type === 'tool_use'
                ? `[looked up ${b.name} ${JSON.stringify(b.input)}]`
                : '',
          )
          .filter(Boolean);
        return parts.length
          ? `${m.role.toUpperCase()}: ${parts.join(' ')}`
          : '';
      })
      .filter(Boolean)
      .join('\n\n');
    const started = Date.now();
    const result = await this.llm.complete(
      {
        model: this.summaryModel,
        system: SUMMARY_SYSTEM,
        tools: [],
        messages: [
          {
            role: 'user',
            content: `<transcript>\n${transcript}\n</transcript>`,
          },
        ],
        maxTokens: 2_000,
      },
      signal,
    );
    await this.meter(
      turn,
      'summary',
      this.summaryModel,
      result,
      null,
      Date.now() - started,
    );
    return textOf(result.content);
  }

  /** Monthly quota (Redis) + billing usage and observability via LlmMeter, per model call. */
  private async meter(
    turn: TurnContext,
    purpose: 'chat' | 'summary',
    requestedModel: string,
    result: LlmTurnResult,
    ttftMs: number | null,
    durationMs: number,
  ) {
    const { tokens } = await this.meterSvc.record({
      subjectId: turn.userId,
      scopeId: turn.conversation.id,
      callId: turn.messageId,
      purpose,
      requestedModel,
      result,
      ttftMs,
      durationMs,
    });
    await this.quota
      .charge(turn.userId, tokens)
      .catch((e) => this.logger.warn(`quota charge failed: ${e.message}`));
  }

  /**
   * Abort-on-disconnect: once nobody has watched the stream for the grace
   * period (a reconnecting phone gets that long), or the user pressed stop,
   * the provider call is aborted - unread tokens aren't paid for.
   */
  private watchViewers(
    messageId: string,
    controller: AbortController,
  ): () => void {
    let lastSeen = Date.now();
    const offCancel = this.buffer.onLocalCancel(messageId, () =>
      controller.abort(),
    );
    const timer = setInterval(
      async () => {
        try {
          if (await this.buffer.isCancelled(messageId))
            return controller.abort();
          if (await this.buffer.hasViewer(messageId)) lastSeen = Date.now();
          else if (Date.now() - lastSeen > this.detachGraceMs)
            controller.abort();
        } catch {
          // Redis hiccup: keep generating rather than abort a healthy turn.
        }
      },
      Math.min(1_000, this.detachGraceMs / 2),
    );
    return () => {
      clearInterval(timer);
      offCancel();
    };
  }

  private userContent(
    input: TurnInput,
  ): Anthropic.Beta.BetaContentBlockParam[] {
    // Per-turn facts live in the (appended) user message, never in the frozen system prompt.
    return [
      { type: 'text', text: input.text },
      {
        type: 'text',
        text: `${CONTEXT_TAG}Location shared for pickup search: ${input.location ? 'yes' : 'no'}.</context>`,
      },
    ];
  }

  private addTotals(totals: Record<string, number>, result: LlmTurnResult) {
    totals.inputTokens += result.usage.inputTokens;
    totals.outputTokens += result.usage.outputTokens;
    totals.cacheReadTokens += result.usage.cacheReadTokens;
    totals.cacheWriteTokens += result.usage.cacheWriteTokens;
    totals.costMicros += costMicros(result.model, result.usage);
  }

  private releaseLock(conversationId: string, messageId: string) {
    return this.redis.client.eval(
      RELEASE_IF_OWNER,
      1,
      turnLockKey(conversationId),
      messageId,
    );
  }
}

const toParam = (m: StoredMessage): MessageParam => ({
  role: m.role,
  content: m.content,
});
const summaryMessage = (summary: string): MessageParam => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: `<conversation_summary>\n${summary}\n</conversation_summary>`,
    },
  ],
});

/**
 * Token deltas → fewer, larger stream entries (one XADD per ~40 ms instead of
 * per token): 50k concurrent streams would otherwise be ~2M Redis writes/s.
 * Writes are chained so order is preserved.
 */
class TextCoalescer {
  private pending = '';
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly write: (text: string) => Promise<void>) {}

  push(delta: string) {
    this.pending += delta;
    if (this.pending.length >= 256) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 40);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.pending;
    this.pending = '';
    if (text) this.chain = this.chain.then(() => this.write(text));
    return this.chain;
  }
}
