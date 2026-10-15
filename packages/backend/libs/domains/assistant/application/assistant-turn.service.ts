import { Inject, Injectable, Logger } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { ApiConfigService } from '@app/common/config';
import { RequestContext } from '@app/infrastructure/context';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  headersFor,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import {
  ADMISSION_STORE,
  CONVERSATION_REPOSITORY,
  GENERATION_STORE,
  MODERATION_PORT,
  type AdmissionStore,
  type ConversationRepository,
  type GenerationStore,
  type ModerationPort,
} from '../domain/assistant-ports';
import { admissionCost } from '../domain/admission';
import { requestFingerprint } from '../domain/request-fingerprint';
import { assistantRatePolicies } from '../rate-limit-policies';
import { AllowanceService } from './allowance.service';
import {
  Domain_AssistantBusy,
  Domain_ConversationFull,
  Domain_ConversationNotFound,
  Domain_IdempotencyInFlight,
  Domain_IdempotencyKeyReuse,
  Domain_InputRejected,
  Domain_QuotaExceeded,
  Domain_TooManyActiveTurns,
  Domain_TurnInProgress,
  ModerationUnavailableError,
  Transient_AssistantUnavailable,
} from './assistant-errors';
import {
  assistantAdmissionRejected,
  assistantFallbackLimiter,
} from './assistant-metrics';
import { ASSISTANT_SYSTEM } from './assistant.prompt';
import { ASSISTANT_TOOLS } from './assistant-tools';
import { GenerationService } from './generation.service';
import { ModelRouter } from './model-router';
import { logIds } from './turn-log';

/** A conversation holds at most 400 messages; a maximal turn is 12 (user + 5 rounds of assistant and tool results). */
export const MAX_STORED_MESSAGES = 400;
export const MAX_TURN_MESSAGES = 12;

export interface SendInput {
  idempotencyKey: string;
  text: string;
  lat?: number;
  lng?: number;
}

export type SendResult =
  | { kind: 'started'; messageId: string; headers: Record<string, string> }
  | { kind: 'replay'; messageId: string; headers: Record<string, string> };

/**
 * Admission of one send (S46 AS-06). The checks run in a fixed order and the first failure decides the answer; a failure
 * at any step releases what the earlier steps took (idempotency key, reply lock, user slot, provider budget), so a
 * rejected send leaves nothing behind (SC-004).
 */
@Injectable()
export class AssistantTurnService {
  private readonly logger = new Logger(AssistantTurnService.name);

  constructor(
    @Inject(CONVERSATION_REPOSITORY)
    private readonly conversations: ConversationRepository,
    @Inject(ADMISSION_STORE) private readonly admission: AdmissionStore,
    @Inject(GENERATION_STORE) private readonly store: GenerationStore,
    @Inject(MODERATION_PORT) private readonly moderation: ModerationPort,
    private readonly limiter: RateLimiterService,
    private readonly allowance: AllowanceService,
    private readonly generations: GenerationService,
    private readonly router: ModelRouter,
    private readonly config: ApiConfigService,
    private readonly context: RequestContext,
  ) {}

  async send(
    userId: string,
    conversationId: string,
    input: SendInput,
  ): Promise<SendResult> {
    if (this.generations.isShuttingDown())
      this.reject(
        'shutting_down',
        new Transient_AssistantUnavailable('shutting_down'),
      );

    const messageId = types.TimeUuid.now().toString();
    const unwind: Array<() => Promise<unknown>> = [];
    try {
      // 3. idempotency key present and not conflicting
      const fingerprint = requestFingerprint({
        conversationId,
        text: input.text,
        lat: input.lat,
        lng: input.lng,
      });
      const claim = await this.admission.claimIdempotency(
        userId,
        input.idempotencyKey,
        { fingerprint, messageId },
      );
      if (claim.kind === 'existing') {
        if (claim.record.fingerprint !== fingerprint)
          this.reject('idempotency_reuse', new Domain_IdempotencyKeyReuse());
        await this.generations.reportIfLost(userId, claim.record.messageId);
        const meta = await this.store.meta(userId, claim.record.messageId);
        if (meta?.state === 'running')
          this.reject(
            'idempotency_in_flight',
            new Domain_IdempotencyInFlight(claim.record.messageId),
          );
        return {
          kind: 'replay',
          messageId: claim.record.messageId,
          headers: {},
        };
      }
      unwind.push(() =>
        this.admission.releaseIdempotency(
          userId,
          input.idempotencyKey,
          messageId,
        ),
      );

      // 4. the conversation is the caller's
      const conversation = await this.conversations.find(
        userId,
        conversationId,
      );
      if (!conversation)
        this.reject('not_found', new Domain_ConversationNotFound());

      // 5. requests per minute
      const rate = await this.limiter.check('llm.messages', userId);
      const headers = headersFor([
        {
          name: 'llm.messages',
          limit: rate.limit,
          windowMs: assistantRatePolicies.policies['llm.messages'].windowMs,
          remaining: rate.remaining,
          resetMs: rate.resetMs,
        },
      ]);
      if (!rate.allowed) {
        if (rate.reason === 'store-unavailable')
          this.reject(
            'rate_limiter_unavailable',
            new Domain_RateLimiterUnavailableError(headers),
          );
        this.reject(
          'rate_limited',
          new Domain_RateLimitedError(
            Math.max(1, Math.ceil((rate.retryAfterMs ?? 1_000) / 1000)),
            headers,
          ),
        );
      }

      // 6. input moderation (before any lock)
      try {
        const verdict = await this.moderation.checkInput(input.text);
        if (verdict.flagged)
          this.reject(
            'input_rejected',
            new Domain_InputRejected(verdict.category),
          );
      } catch (error) {
        if (error instanceof ModerationUnavailableError) {
          this.logger.warn(
            `moderation unavailable at admission ${logIds({ requestId: this.context.requestId, conversationId, messageId })}`,
          );
          this.reject(
            'moderation_unavailable',
            new Transient_AssistantUnavailable('moderation_unavailable'),
          );
        }
        throw error;
      }

      // 7. conversation size
      const stored = await this.conversations.messageCount(
        userId,
        conversationId,
      );
      if (stored >= MAX_STORED_MESSAGES - MAX_TURN_MESSAGES)
        this.reject('conversation_full', new Domain_ConversationFull());

      // 8. monthly allowance
      const allowance = await this.allowance
        .current(userId)
        .catch((error: unknown) => {
          if (error instanceof Transient_AssistantUnavailable)
            this.reject(error.reason, error);
          throw error;
        });
      if (allowance.used >= allowance.limit)
        this.reject(
          'quota_exceeded',
          new Domain_QuotaExceeded(
            allowance.retryAfterSeconds,
            allowance.used,
            allowance.limit,
            allowance.resetsAt.toISOString(),
          ),
        );

      // 9. one reply per conversation
      const lockTtlMs = this.config.get('assistant_turn_timeout_ms') + 30_000;
      let locked = await this.admission.acquireLock(
        userId,
        conversationId,
        messageId,
        lockTtlMs,
      );
      if (
        !locked &&
        (await this.generations.reclaimLock(userId, conversationId))
      )
        locked = await this.admission.acquireLock(
          userId,
          conversationId,
          messageId,
          lockTtlMs,
        );
      if (!locked) this.reject('turn_in_progress', new Domain_TurnInProgress());
      unwind.push(() =>
        this.admission.releaseLock(userId, conversationId, messageId),
      );

      // 10. replies per user
      const cap = this.config.get('assistant_max_active_turns');
      let slot = await this.admission.acquireSlot(
        userId,
        messageId,
        cap,
        lockTtlMs,
      );
      if (!slot) {
        await this.generations.reclaimSlots(userId);
        slot = await this.admission.acquireSlot(
          userId,
          messageId,
          cap,
          lockTtlMs,
        );
      }
      if (!slot)
        this.reject('too_many_active_turns', new Domain_TooManyActiveTurns());
      unwind.push(() => this.admission.releaseSlot(userId, messageId));

      // 11. fleet-wide provider token budget (weighted by the request size)
      const model = this.config.get('assistant_model');
      const cost = admissionCost({
        systemChars: JSON.stringify(ASSISTANT_SYSTEM).length,
        toolsChars: JSON.stringify(ASSISTANT_TOOLS).length,
        textChars: input.text.length,
      });
      const budget = await this.limiter.check('llm.provider.tpm', model, cost);
      if (!budget.allowed)
        this.reject(
          'assistant_busy',
          new Domain_AssistantBusy(budget.retryAfterMs ?? 1_000),
        );
      if (budget.source === 'fallback') {
        // The store is down and the policy fails open: the provider's own 429 is the backstop.
        assistantFallbackLimiter.add(1, { policy: 'llm.provider.tpm' });
        this.logger.warn(
          `provider budget limiter unavailable, admitted without it ${logIds({ requestId: this.context.requestId, conversationId, messageId })}`,
        );
      } else {
        unwind.push(() => this.limiter.refund('llm.provider.tpm', model, cost));
      }

      // 12. breakers
      const blockedFor = await this.router.allBlockedFor();
      if (blockedFor !== null)
        this.reject(
          'providers_unavailable',
          new Transient_AssistantUnavailable(
            'providers_unavailable',
            blockedFor,
          ),
        );

      await this.store.start(userId, messageId, conversationId);
      this.generations.launch({
        userId,
        conversation,
        messageId,
        requestId: this.context.requestId,
        text: input.text,
        location:
          input.lat !== undefined && input.lng !== undefined
            ? { lat: input.lat, lng: input.lng }
            : null,
      });
      return { kind: 'started', messageId, headers };
    } catch (error) {
      // Newest first: the budget, the slot, the lock, then the key.
      for (const undo of unwind.reverse()) await undo().catch(() => undefined);
      throw error;
    }
  }

  /** Counts the rejection by reason and throws it. */
  private reject(reason: string, error: Error): never {
    assistantAdmissionRejected.add(1, { reason });
    throw error;
  }
}
