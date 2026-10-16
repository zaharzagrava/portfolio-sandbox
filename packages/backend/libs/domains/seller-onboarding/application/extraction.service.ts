import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { SecretBox } from '@app/domains/identity';
import {
  LLM_PROVIDER,
  LlmCallRecorder,
  textOf,
} from '@app/infrastructure/llm';
import type { LlmProvider } from '@app/infrastructure/llm';
import {
  ATTEMPTS,
  APPLICATIONS,
  DOCUMENTS,
  REVIEW_TASKS,
  STATUS_HISTORY,
  type ApplicationRepository,
  type AttemptRepository,
  type ClaimedDocument,
  type DocumentRecord,
  type DocumentRepository,
  type ReviewTaskRepository,
  type StatusHistoryRepository,
} from '../domain/ports';
import type { Answers } from '../domain/questionnaire';
import type { ExtractionConfig } from '../domain/extraction-config';
import {
  evaluateExtraction,
  outcomeFor,
  type ExtractionOutcome,
  type Issue,
} from '../domain/extraction-rules';
import { detectFileType } from '../domain/file-type';
import {
  EXTRACTION_SYSTEM,
  type Extraction,
  jsonSchemaFor,
  PROMPT_VERSION,
  SENSITIVE_FIELDS,
} from '../domain/extraction-schema';
import { maskIban } from '../domain/validators';
import { EXTRACTION_CONFIG } from './extraction-config.token';
import { onboardingMetrics } from './onboarding-metrics';
import { VerificationPolicyService } from './verification-policy.service';

/** Why a document went to a human without the pipeline reading it (bounded: it is a metric label). */
export type RouteReason =
  'file_missing' | 'extraction_unavailable' | 'content_type_mismatch';

/** The key a sealed value is bound to: a ciphertext copied to another row or attempt fails to open (R-08). */
export const sealContext = (documentId: string, attempt: number) =>
  `kyc:${documentId}:${attempt}`;

/**
 * KYC extraction (SD-44, S04 FR-020…FR-028):
 *  1. claim the document with a lease (`QUEUED → EXTRACTING`); a second worker, a redelivery or a message for a decided
 *     document finds nothing to claim and acknowledges without effect,
 *  2. the cheap model first (structured output, no tools, 45 s, no retry: the queue is the retry layer), strict
 *     re-validation, business rules decide - not the model's confidence,
 *  3. a failure a better reader could fix → ONE escalation; anything still failing → the human review queue,
 *  4. a conditional finish asserts one row: a document superseded meanwhile discards the result.
 * The storage read and the model calls happen outside any transaction (III.3); the claim and the finish are short ones.
 * Every attempt is stored once (masked view + sealed copy bound to its row and attempt), so a redelivery resumes where
 * the previous worker stopped and attempt 1 is never paid twice.
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);

  constructor(
    @Inject(APPLICATIONS) private readonly applications: ApplicationRepository,
    @Inject(DOCUMENTS) private readonly documents: DocumentRepository,
    @Inject(ATTEMPTS) private readonly attempts: AttemptRepository,
    @Inject(REVIEW_TASKS) private readonly tasks: ReviewTaskRepository,
    @Inject(STATUS_HISTORY) private readonly history: StatusHistoryRepository,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(EXTRACTION_CONFIG) private readonly config: ExtractionConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly recorder: LlmCallRecorder,
    private readonly storage: ObjectStorage,
    private readonly secrets: SecretBox,
    private readonly verification: VerificationPolicyService,
    private readonly transactions: TransactionRunner,
  ) {}

  private modelFor(attempt: number) {
    return attempt === 1
      ? this.config.extractionModel
      : this.config.escalationModel;
  }

  /**
   * SQS/Lambda handler body. A provider error propagates (the queue retries, then dead-letters); the lease is released
   * first so the redelivery can take the document at once. Everything else ends in APPROVED or NEEDS_REVIEW.
   */
  async process(documentId: string): Promise<void> {
    const started = this.clock.now();
    const doc = await this.claim(documentId);
    if (!doc) return; // decided, superseded, held by another worker, or unknown

    try {
      await this.read(doc, started);
    } catch (error) {
      await this.releaseLease(doc.id);
      throw error;
    }
  }

  private async read(doc: ClaimedDocument, started: Date): Promise<void> {
    const application = await this.applications.find(doc.shopId);
    const answers: Answers | null = application?.answers ?? null;
    const previous = await this.attempts.list(doc.id);
    const last = previous.at(-1) ?? null;
    let attempt = (last?.attempt ?? 0) + 1;

    // A previous worker stored a final attempt but died before finishing: finish with what it decided.
    if (last && last.outcome !== 'ESCALATE')
      return this.finish(doc, last.outcome, last.issues, started);

    const head = await this.storage.head(doc.storageKey);
    if (!head) return this.routeClaimed(doc, 'file_missing', started);
    const bytes = await this.readBytes(doc);
    if (detectFileType(bytes) !== doc.contentType)
      return this.routeClaimed(doc, 'content_type_mismatch', started);

    let outcome: ExtractionOutcome = last?.outcome ?? 'ESCALATE';
    let issues: Issue[] = last?.issues ?? [];
    for (; attempt <= this.config.maxAttempts && outcome === 'ESCALATE'; attempt++) {
      const model = this.modelFor(attempt);
      const callStarted = this.clock.now();
      const result = await this.llm.complete({
        model,
        system: [
          {
            type: 'text',
            text: EXTRACTION_SYSTEM,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [],
        messages: [
          {
            role: 'user',
            content: [
              documentBlock(doc.contentType, bytes),
              {
                type: 'text',
                text: `This was uploaded as: ${doc.kind}. Extract the fields.`,
              },
            ],
          },
        ],
        maxTokens: 2_000,
        effort: 'low',
        outputSchema: jsonSchemaFor(doc.kind),
        // The queue is this job's retry layer: one bounded attempt per delivery.
        timeoutMs: this.config.modelTimeoutMs,
        maxRetries: 0,
      });
      await this.meter(doc, attempt, model, result, callStarted);

      const evaluated = evaluateExtraction(
        doc.kind,
        {
          refused: result.stopReason === 'refusal',
          text: textOf(result.content),
        },
        answers,
        this.clock.now(),
        {
          nameMatchThreshold: this.config.nameMatchThreshold,
          statementMaxAgeDays: this.config.statementMaxAgeDays,
        },
      );
      issues = evaluated.issues;
      outcome = outcomeFor(issues, attempt, this.config.maxAttempts);
      await this.attempts.insert({
        documentId: doc.id,
        attempt,
        model: result.model,
        promptVersion: PROMPT_VERSION,
        fields: evaluated.extraction ? masked(evaluated.extraction) : {},
        sealedFields: this.secrets.seal(
          JSON.stringify(evaluated.extraction ?? null),
          sealContext(doc.id, attempt),
        ),
        issues,
        outcome,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        now: this.clock.now(),
      });
      onboardingMetrics.outcomes.add(1, {
        kind: doc.kind,
        attempt: String(attempt),
        outcome,
      });
    }

    await this.finish(
      doc,
      outcome === 'ACCEPTED' ? 'ACCEPTED' : 'REVIEW',
      issues,
      started,
    );
  }

  /**
   * Sends a document to a human without (further) reading: a message parked in the dead-letter queue
   * (`extraction_unavailable`), a missing object, a type mismatch. Idempotent: a document that is not waiting for the
   * pipeline (`QUEUED`, or `EXTRACTING` whose worker is gone) is left alone. It claims first (`QUEUED → EXTRACTING`),
   * then moves `EXTRACTING → NEEDS_REVIEW`, so the status machine stays as specified.
   */
  async routeToReview(documentId: string, reason: RouteReason): Promise<void> {
    const now = this.clock.now();
    await this.transactions.run(async () => {
      const doc = await this.documents.findById(documentId);
      if (!doc) return;
      if (doc.status === 'QUEUED') {
        const claimed = await this.documents.claim({
          id: doc.id,
          now,
          leaseUntil: new Date(now.getTime() + this.config.leaseMs),
        });
        if (!claimed) return;
        await this.history.append({
          entity: 'DOCUMENT',
          entityId: doc.id,
          shopId: doc.shopId,
          fromStatus: 'QUEUED',
          toStatus: 'EXTRACTING',
          actor: 'worker',
          at: now,
        });
      } else if (doc.status !== 'EXTRACTING') return;
      await this.moveToReview(doc, [{ field: null, code: reason, escalate: false }], now);
    });
    onboardingMetrics.failures.add(1, { reason });
  }

  private async claim(documentId: string): Promise<ClaimedDocument | null> {
    const now = this.clock.now();
    return this.transactions.run(async () => {
      const claimed = await this.documents.claim({
        id: documentId,
        now,
        leaseUntil: new Date(now.getTime() + this.config.leaseMs),
      });
      if (claimed && claimed.previousStatus === 'QUEUED')
        await this.history.append({
          entity: 'DOCUMENT',
          entityId: claimed.id,
          shopId: claimed.shopId,
          fromStatus: 'QUEUED',
          toStatus: 'EXTRACTING',
          actor: 'worker',
          at: now,
        });
      return claimed;
    });
  }

  private async releaseLease(documentId: string): Promise<void> {
    try {
      await this.documents.releaseLease(documentId, this.clock.now());
    } catch (error) {
      // the lease lapses by itself after leaseMs: the redelivery is late, not lost
      this.logger.warn(
        `could not release the lease of document ${documentId}: ${(error as Error).name}`,
      );
    }
  }

  private async routeClaimed(
    doc: ClaimedDocument,
    reason: RouteReason,
    started: Date,
  ): Promise<void> {
    onboardingMetrics.failures.add(1, { reason });
    await this.finish(
      doc,
      'REVIEW',
      [{ field: null, code: reason, escalate: false }],
      started,
    );
  }

  /**
   * The conditional finish (A7): one short transaction. When the document is no longer `EXTRACTING` (superseded while
   * the model was reading) the result is discarded - no task, no verification, no event.
   */
  private async finish(
    doc: DocumentRecord,
    outcome: ExtractionOutcome,
    issues: Issue[],
    started: Date,
  ): Promise<void> {
    const now = this.clock.now();
    const approved = outcome === 'ACCEPTED';
    await this.transactions.run(async () => {
      if (approved) {
        if (!(await this.documents.finish({ id: doc.id, to: 'APPROVED', now })))
          return;
        await this.history.append({
          entity: 'DOCUMENT',
          entityId: doc.id,
          shopId: doc.shopId,
          fromStatus: 'EXTRACTING',
          toStatus: 'APPROVED',
          actor: 'worker',
          at: now,
        });
        await this.verification.evaluate(doc.shopId);
      } else {
        await this.moveToReview(doc, issues, now);
      }
    });
    onboardingMetrics.duration.record(
      Math.max(0, now.getTime() - started.getTime()) / 1000,
      { kind: doc.kind, outcome: approved ? 'approved' : 'review' },
    );
  }

  /** `EXTRACTING → NEEDS_REVIEW` plus the one open task, inside the caller's transaction. */
  private async moveToReview(
    doc: DocumentRecord,
    issues: Issue[],
    now: Date,
  ): Promise<void> {
    if (!(await this.documents.finish({ id: doc.id, to: 'NEEDS_REVIEW', now })))
      return;
    await this.history.append({
      entity: 'DOCUMENT',
      entityId: doc.id,
      shopId: doc.shopId,
      fromStatus: 'EXTRACTING',
      toStatus: 'NEEDS_REVIEW',
      actor: 'worker',
      at: now,
    });
    await this.tasks.open({
      documentId: doc.id,
      shopId: doc.shopId,
      reasons: issues,
      now,
    });
  }

  /** Reports one call to the metering path; a metering failure never fails the extraction. */
  private async meter(
    doc: DocumentRecord,
    attempt: number,
    model: string,
    result: Awaited<ReturnType<LlmProvider['complete']>>,
    callStarted: Date,
  ): Promise<void> {
    onboardingMetrics.tokens.add(result.usage.inputTokens, {
      model,
      direction: 'input',
    });
    onboardingMetrics.tokens.add(result.usage.outputTokens, {
      model,
      direction: 'output',
    });
    try {
      await this.recorder.record({
        subjectId: doc.shopId,
        scopeId: doc.id,
        callId: `${doc.id}:${attempt}`,
        purpose: 'extraction',
        metric: 'llm.extraction.tokens',
        requestedModel: model,
        outcome: result.stopReason === 'refusal' ? 'refused' : 'completed',
        result,
        ttftMs: null,
        durationMs: Math.max(0, this.clock.now().getTime() - callStarted.getTime()),
      });
    } catch (error) {
      onboardingMetrics.failures.add(1, { reason: 'metering_failed' });
      this.logger.warn(`call usage not recorded: ${(error as Error).name}`);
    }
  }

  private async readBytes(doc: DocumentRecord): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of await this.storage.getStream(doc.storageKey))
      parts.push(part as Buffer);
    return Buffer.concat(parts);
  }
}

function documentBlock(
  contentType: string,
  bytes: Buffer,
): Anthropic.Beta.BetaContentBlockParam {
  const data = bytes.toString('base64');
  return contentType === 'application/pdf'
    ? {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: contentType as 'image/jpeg' | 'image/png' | 'image/webp',
          data,
        },
      };
}

/** Loggable/displayable view: sensitive values masked, evidence dropped (it quotes the sensitive value). */
export function masked(extraction: Extraction) {
  return {
    documentType: extraction.documentType,
    legible: extraction.legible,
    fields: Object.fromEntries(
      Object.entries(extraction.fields).map(([f, fv]) => [
        f,
        {
          value:
            fv.value && SENSITIVE_FIELDS.has(f) ? maskIban(fv.value) : fv.value,
          confidence: fv.confidence,
        },
      ]),
    ),
  };
}
