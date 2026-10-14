import { Inject, Injectable, Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  Domain_RateLimitCostExceededError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { citationsOf } from '../domain/citations';
import {
  assistantBusy,
  assistantUnavailable,
  inputRejected,
  notFound,
  RetrievalUnavailableError,
} from '../domain/knowledge-errors';
import { ragAnswers, ragModerationRejected } from '../domain/knowledge-metrics';
import {
  ANSWER_MODEL,
  AnswerAbortedError,
  AnswerUnavailableError,
  CALL_RECORDER,
  MODERATOR,
  PRODUCT_DIRECTORY,
  SHOP_DIRECTORY,
} from '../domain/ports';
import type {
  AnswerModel,
  AnswerResult,
  AnswerUsage,
  CallOutcome,
  CallRecorder,
  ModerationVerdict,
  Moderator,
  ProductDirectory,
  ShopDirectory,
} from '../domain/ports';
import { buildAnswerRequest, estimateAnswerTokens } from '../domain/prompt';
import type { RetrievalScope } from '../domain/scope';
import { KnowledgeSearchService } from './knowledge-search.service';

export type AskTarget =
  /** Buyer asking about a product (anonymous allowed). */
  | { kind: 'product'; productId: string }
  /** Shop member asking the help center. */
  | { kind: 'shop'; shopId: string };

/** The SSE stream as the service sees it; the controller binds it to the HTTP response. */
export interface AskSink {
  /** Writes the stream headers. Called only after every pre-stream check passed. */
  begin(): void;
  send(event: string, data: unknown): void;
  end(): void;
  /** The client went away (the response closed). */
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

export const MODERATION_INPUT_TIMEOUT_MS = 200;
const MODERATION_CONTEXT_CHARS = 256;
const NOT_FOUND_PRODUCT =
  "I couldn't find this in the product documentation. Try asking the seller.";
const NOT_FOUND_SHOP =
  "I couldn't find this in the help center or in your documents. Try rephrasing your question.";

/** How a question ended, for the one log line and the span attributes. */
interface Observation {
  outcome:
    'answered' | 'not_found' | 'refused' | 'error' | 'aborted' | 'rejected';
  mode?: 'hybrid' | 'keyword';
  passages?: number;
  /** The problem code of a rejection. */
  code?: string;
}

const STREAM_OUTCOME: Record<CallOutcome, Observation['outcome']> = {
  completed: 'answered',
  failed: 'error',
  refused: 'refused',
  aborted: 'aborted',
};

type AbortReason =
  'client' | 'first_token' | 'answer' | 'moderation' | 'moderation_error';

const withDeadline = <T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('deadline'));
      }, ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
};

/**
 * "Ask this product" and the shop help center (S47 FR-030 – FR-038). The admission order after the framework's
 * authentication, body validation and rate limit is fixed and the first failing check decides the answer:
 *
 *   product/shop lookup (404) → input moderation (422 / 503) → provider budget (429 assistant_busy)
 *   → retrieval (503) → `not_found` (no model call, no record) or the stream.
 *
 * The stream headers are written only after retrieval succeeded, so every rejection is a plain problem+json. Every
 * attempted model call is recorded exactly once (completed, failed, refused or aborted), citations come from the
 * provider's structured data validated against the retrieved set, and the answer is moderated chunk by chunk.
 */
@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);

  constructor(
    private readonly search: KnowledgeSearchService,
    @Inject(PRODUCT_DIRECTORY) private readonly products: ProductDirectory,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectory,
    @Inject(MODERATOR) private readonly moderator: Moderator,
    @Inject(ANSWER_MODEL) private readonly model: AnswerModel,
    @Inject(CALL_RECORDER) private readonly recorder: CallRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly limiter: RateLimiterService,
    private readonly config: ApiConfigService,
  ) {}

  async ask(
    userId: string | null,
    target: AskTarget,
    question: string,
    sink: AskSink,
  ): Promise<void> {
    const started = this.clock.nowMs();
    const hash = this.search.questionHash(question);
    let seen: Observation = { outcome: 'rejected', code: 'internal_error' };
    try {
      seen = await this.run(userId, target, question, sink);
    } catch (error) {
      seen = {
        outcome: 'rejected',
        code: (error as { code?: string }).code ?? 'internal_error',
      };
      throw error;
    } finally {
      this.observe(hash, seen, this.clock.nowMs() - started);
    }
  }

  /** The admission pipeline and the stream; returns how the question ended, for the one log line and the span. */
  private async run(
    userId: string | null,
    target: AskTarget,
    question: string,
    sink: AskSink,
  ): Promise<Observation> {
    const scope = await this.resolve(target);
    await this.moderateInput(question);
    await this.takeBudget(question);

    let retrieved;
    try {
      retrieved = await this.search.search(scope, question);
    } catch (error) {
      if (error instanceof RetrievalUnavailableError)
        throw assistantUnavailable();
      throw error;
    }
    const seen = { mode: retrieved.mode, passages: retrieved.items.length };

    sink.begin();
    if (!retrieved.items.length) {
      ragAnswers.add(1, { outcome: 'not_found' });
      sink.send('not_found', {
        message: target.kind === 'product' ? NOT_FOUND_PRODUCT : NOT_FOUND_SHOP,
      });
      sink.end();
      return { outcome: 'not_found', ...seen };
    }
    sink.send('sources', {
      mode: retrieved.mode,
      items: retrieved.items.map((c, n) => ({
        n,
        chunkId: c.id,
        documentId: c.documentId,
        title: c.title,
        headingPath: c.headingPath,
        page: c.page,
      })),
    });
    const outcome = await this.stream({
      userId,
      scopeId: target.kind === 'product' ? target.productId : target.shopId,
      question,
      items: retrieved.items,
      sink,
    });
    return { outcome, ...seen };
  }

  /**
   * One log line and the active span's attributes per question (S47 AS-53): ids, counts, durations and the question's
   * hash prefix only - never the question, a passage, a title or a provider message.
   */
  private observe(hash: string, seen: Observation, durationMs: number): void {
    const fields = {
      'rag.outcome': seen.outcome,
      'rag.question_hash': hash,
      'rag.duration_ms': durationMs,
      ...(seen.mode ? { 'rag.mode': seen.mode } : {}),
      ...(seen.passages !== undefined ? { 'rag.passages': seen.passages } : {}),
      ...(seen.code ? { 'rag.problem': seen.code } : {}),
    };
    trace.getActiveSpan()?.setAttributes(fields);
    this.logger.log(
      `rag question outcome=${seen.outcome} question=${hash} mode=${seen.mode ?? '-'} passages=${seen.passages ?? '-'} problem=${seen.code ?? '-'} ms=${durationMs}`,
    );
  }

  // ------------------------------------------------------------ admission

  /** Unknown or archived product, or a shop that is not active: the same 404 (no existence leak). */
  private async resolve(target: AskTarget): Promise<RetrievalScope> {
    if (target.kind === 'shop') return { kind: 'shop', shopId: target.shopId };
    const product = (await this.products.getProducts([target.productId])).get(
      target.productId.toLowerCase(),
    );
    if (!product || product.status !== 'ACTIVE') throw notFound('The product');
    const shop = (await this.shops.getShops([product.shopId])).get(
      product.shopId,
    );
    if (!shop || shop.status !== 'ACTIVE') throw notFound('The product');
    return { kind: 'product', productId: product.id, shopId: product.shopId };
  }

  /** Fail closed: a flagged question is 422 with its category; a slow or broken moderator is 503. */
  private async moderateInput(question: string): Promise<void> {
    const controller = new AbortController();
    let verdict: ModerationVerdict;
    try {
      verdict = await withDeadline(
        this.moderator.moderateInput(question, { signal: controller.signal }),
        MODERATION_INPUT_TIMEOUT_MS,
        controller,
      );
    } catch {
      throw assistantUnavailable();
    }
    if (verdict.flagged) {
      ragModerationRejected.add(1, { category: verdict.category });
      throw inputRejected(verdict.category);
    }
  }

  /** The fleet-wide provider budget, charged with the estimated tokens before any retrieval or stream. */
  private async takeBudget(question: string): Promise<void> {
    const cost = estimateAnswerTokens(question, this.config.get('rag_top_k'));
    const decision = await this.limiter.check(
      'llm.provider.tpm',
      this.config.get('rag_model'),
      cost,
    );
    if (decision.allowed) return;
    if (decision.reason === 'cost-exceeds-limit')
      throw new Domain_RateLimitCostExceededError();
    throw assistantBusy(
      Math.max(1, Math.ceil((decision.retryAfterMs ?? 1000) / 1000)),
    );
  }

  // --------------------------------------------------------------- stream

  private async stream(input: {
    userId: string | null;
    scopeId: string;
    question: string;
    items: Awaited<ReturnType<KnowledgeSearchService['search']>>['items'];
    sink: AskSink;
  }): Promise<Observation['outcome']> {
    const { sink, items } = input;
    const requestedModel = this.config.get('rag_model');
    const request = buildAnswerRequest({
      model: requestedModel,
      items,
      question: input.question,
    });
    const controller = new AbortController();
    // Assigned from timers and callbacks: a holder object keeps the compiler from narrowing it to `null`.
    const state: { reason: AbortReason | null } = { reason: null };
    let moderationCategory = 'general';
    const abort = (why: AbortReason) => {
      state.reason ??= why;
      controller.abort();
    };
    sink.onClose(() => abort('client'));
    if (sink.closed) abort('client');

    const started = this.clock.nowMs();
    let ttftMs: number | null = null;
    let streamed = '';
    let firstToken: NodeJS.Timeout | undefined = setTimeout(
      () => abort('first_token'),
      this.config.get('rag_first_token_timeout_ms'),
    );
    const wholeAnswer = setTimeout(
      () => abort('answer'),
      this.config.get('rag_answer_timeout_ms'),
    );

    // The provider's callback is synchronous; moderation is not. Chunks are chained so they reach the client in order.
    let pending: Promise<void> = Promise.resolve();
    const onText = (t: string) => {
      if (firstToken) {
        clearTimeout(firstToken);
        firstToken = undefined;
        ttftMs = this.clock.nowMs() - started;
      }
      pending = pending.then(async () => {
        if (state.reason) return;
        const context = streamed.slice(-MODERATION_CONTEXT_CHARS);
        try {
          const checker = new AbortController();
          const verdict = await withDeadline(
            this.moderator.moderateOutput(t, context, {
              signal: checker.signal,
            }),
            MODERATION_INPUT_TIMEOUT_MS,
            checker,
          );
          if (verdict.flagged) {
            moderationCategory = verdict.category;
            return abort('moderation');
          }
        } catch {
          return abort('moderation_error');
        }
        streamed += t;
        sink.send('text', { t });
      });
    };

    let outcome: CallOutcome = 'failed';
    let result: AnswerResult | null = null;
    try {
      result = await this.model.stream(request, {
        signal: controller.signal,
        onText,
      });
      await pending;
      if (state.reason === 'moderation' || state.reason === 'moderation_error')
        throw new AnswerAbortedError();
      if (result.refused) {
        outcome = 'refused';
        ragAnswers.add(1, { outcome: 'refused' });
        sink.send('refusal', {
          category: result.refusalCategory ?? 'general',
          source: 'provider',
        });
      } else {
        outcome = 'completed';
        ragAnswers.add(1, { outcome: 'answered' });
        sink.send('done', citationsOf(result.blocks, items.length));
      }
    } catch (error) {
      await pending.catch(() => undefined);
      outcome = this.endFailed(error, state.reason, moderationCategory, sink);
    } finally {
      if (firstToken) clearTimeout(firstToken);
      clearTimeout(wholeAnswer);
      await this.record({
        userId: input.userId,
        scopeId: input.scopeId,
        outcome,
        requestedModel,
        result,
        request,
        streamed,
        ttftMs,
        durationMs: this.clock.nowMs() - started,
      });
      sink.end();
    }
    return STREAM_OUTCOME[outcome];
  }

  /** Maps how the call ended to the last event of the stream and the outcome to record. */
  private endFailed(
    error: unknown,
    reason: AbortReason | null,
    category: string,
    sink: AskSink,
  ): CallOutcome {
    if (reason === 'client') {
      ragAnswers.add(1, { outcome: 'aborted' });
      return 'aborted'; // nothing more is written to a client that is gone
    }
    if (reason === 'moderation') {
      ragAnswers.add(1, { outcome: 'refused' });
      sink.send('refusal', { category, source: 'moderation' });
      return 'refused';
    }
    ragAnswers.add(1, { outcome: 'error' });
    if (reason === 'first_token' || reason === 'answer')
      sink.send('error', { code: 'TIMEOUT' });
    else if (error instanceof AnswerUnavailableError)
      sink.send('error', { code: 'PROVIDER_UNAVAILABLE' });
    else {
      this.logger.error(`rag answer failed: ${(error as Error).name}`);
      sink.send('error', { code: 'INTERNAL' });
    }
    return 'failed';
  }

  /** One record per attempted call. Counts come from the provider; failed and aborted calls get an estimate (chars / 4). */
  private async record(call: {
    userId: string | null;
    scopeId: string;
    outcome: CallOutcome;
    requestedModel: string;
    result: AnswerResult | null;
    request: ReturnType<typeof buildAnswerRequest>;
    streamed: string;
    ttftMs: number | null;
    durationMs: number;
  }): Promise<void> {
    const zero: AnswerUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let usage = call.result?.usage ?? zero;
    let usageEstimated = false;
    if (
      !call.result &&
      (call.outcome === 'aborted' || call.streamed.length > 0)
    ) {
      const promptChars =
        call.request.instructions.length +
        call.request.question.length +
        call.request.passages.reduce(
          (n, p) => n + p.text.length + p.title.length,
          0,
        );
      usage = {
        ...zero,
        inputTokens: Math.ceil(promptChars / 4),
        outputTokens: Math.ceil(call.streamed.length / 4),
      };
      usageEstimated = true;
    }
    try {
      await this.recorder.record({
        callId: uuidv7(),
        subjectId: call.userId ?? 'anonymous',
        scopeId: call.scopeId,
        outcome: call.outcome,
        requestedModel: call.requestedModel,
        model: call.result?.model ?? null,
        usage,
        usageEstimated,
        ttftMs: call.ttftMs,
        durationMs: call.durationMs,
        stopReason: call.result?.stopReason ?? call.outcome,
      });
    } catch (error) {
      this.logger.warn(`call not recorded: ${(error as Error).name}`);
    }
  }
}
