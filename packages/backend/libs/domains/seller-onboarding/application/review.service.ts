import { Inject, Injectable } from '@nestjs/common';
import type {
  ReviewQueuePage,
  ReviewResolveRequest,
  ReviewResolveResult,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { assertActiveTransaction } from '@app/infrastructure/context/transaction-scope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { SecretBox } from '@app/domains/identity';
import { ShopAccessService, ShopQueryService } from '@app/domains/tenancy';
import {
  FIELDS,
  PROMPT_VERSION,
  SENSITIVE_FIELDS,
  type Extraction,
} from '../domain/extraction-schema';
import { isValidIban, isValidVat, maskIban } from '../domain/validators';
import type { DocumentKind } from '../domain/questionnaire';
import {
  alreadyVerified,
  conflictOfInterest,
  documentSuperseded,
  missingFields,
  ibanInvalid,
  OnboardingError,
  reviewTaskNotFound,
  taskAlreadyResolved,
  validationFailed,
  vatInvalid,
} from '../domain/errors';
import {
  APPLICATIONS,
  ATTEMPTS,
  DOCUMENTS,
  REVIEW_TASKS,
  STATUS_HISTORY,
  type ApplicationRepository,
  type AttemptRepository,
  type DocumentRepository,
  type ReviewQueueRow,
  type ReviewTaskForResolve,
  type ReviewTaskRepository,
  type StatusHistoryRepository,
} from '../domain/ports';
import {
  OnboardingDocumentRejected,
  outcomeVersion,
  ShopRejected,
} from './events/onboarding-events';
import { masked, sealContext } from './extraction.service';
import { OnboardingAudit } from './onboarding-audit';
import { onboardingMetrics } from './onboarding-metrics';
import { RetentionScheduler } from './retention-scheduler';
import { VerificationPolicyService } from './verification-policy.service';

const LINK_SECONDS = 300;

/** Fields a document of a kind must carry for a human to approve it (AS-42). */
const KEY_FIELDS: Record<DocumentKind, readonly string[]> = {
  BUSINESS_REGISTRATION: ['legalName', 'registrationNumber', 'country'],
  VAT_CERTIFICATE: ['vatNumber'],
  BANK_STATEMENT: ['accountHolder', 'iban'],
};

interface Cursor {
  createdAt: Date;
  id: string;
}

const encodeCursor = (c: Cursor) =>
  Buffer.from(
    JSON.stringify({ c: c.createdAt.toISOString(), i: c.id }),
  ).toString('base64url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor that does not decode to `{c: ISO instant, i: uuid}` is refused (AS-38). */
function decodeCursor(raw: string): Cursor {
  const invalid = () =>
    validationFailed([{ path: 'cursor', message: 'Invalid cursor' }]);
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const createdAt = new Date(parsed?.c);
    if (
      typeof parsed?.c !== 'string' ||
      typeof parsed?.i !== 'string' ||
      !UUID.test(parsed.i) ||
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== parsed.c
    )
      throw invalid();
    return { createdAt, id: parsed.i };
  } catch (error) {
    throw error instanceof OnboardingError ? error : invalid();
  }
}

type Decision = ReviewResolveRequest['decision'];
type Outcome = ReviewResolveResult['status'];

/**
 * Human-in-the-loop queue (S04 FR-030…FR-035). Reviewers see masked values, the reasons the pipeline stopped and a
 * short-lived link to the file. Every decision is one transaction that locks the application, then the task, and ends in
 * conditional updates that assert one row - so exactly one of two racing reviewers wins (AS-44) and an approval
 * evaluates the verification in the same transaction (FR-040). Corrections are stored as masked `{extracted, corrected}`
 * pairs: the labelled data of the extraction eval set and the per-field correction rate.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(APPLICATIONS) private readonly applications: ApplicationRepository,
    @Inject(DOCUMENTS) private readonly documents: DocumentRepository,
    @Inject(ATTEMPTS) private readonly attempts: AttemptRepository,
    @Inject(REVIEW_TASKS) private readonly tasks: ReviewTaskRepository,
    @Inject(STATUS_HISTORY) private readonly history: StatusHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly storage: ObjectStorage,
    private readonly secrets: SecretBox,
    private readonly shops: ShopQueryService,
    private readonly access: ShopAccessService,
    private readonly events: OutboxService,
    private readonly verification: VerificationPolicyService,
    private readonly retention: RetentionScheduler,
    private readonly audit: OnboardingAudit,
  ) {}

  async queue(
    reviewerId: string,
    query: { kind?: DocumentKind; limit: number; cursor?: string },
  ): Promise<ReviewQueuePage> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const found = await this.tasks.page({
      after,
      limit: query.limit + 1,
      kind: query.kind ?? null,
    });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      found.length > query.limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    // One call to tenancy per page, ids de-duplicated (AS-63).
    const ids = [...new Set(page.map((r) => r.shopId))];
    const names = ids.length ? await this.shops.getShopsByIds(ids) : new Map();
    const items = await Promise.all(
      page.map((row) => this.toItem(row, names, reviewerId)),
    );
    await this.refreshQueueAge();
    return { items, nextCursor };
  }

  async resolve(
    taskId: string,
    reviewerId: string,
    input: ReviewResolveRequest,
  ): Promise<ReviewResolveResult> {
    const known = await this.tasks.find(taskId);
    const audit = (outcome: string) =>
      this.audit.record({
        event: 'review.resolve',
        reviewerId,
        taskId,
        shopId: known?.shopId ?? null,
        decision: input.decision,
        outcome,
      });
    try {
      if (!known) throw reviewTaskNotFound();
      // A reviewer who belongs to the shop under review may not decide on it (four-eyes, AS-47).
      if ((await this.access.getRole(known.shopId, reviewerId)) !== null)
        throw conflictOfInterest();

      const result = await this.transactions.run(() =>
        this.decide(taskId, reviewerId, input),
      );
      onboardingMetrics.decisions.add(1, {
        kind: result.kind,
        decision: result.status,
      });
      for (const field of result.correctedFields)
        onboardingMetrics.corrections.add(1, { kind: result.kind, field });
      await this.refreshQueueAge();
      audit('accepted');
      return { status: result.status, shopVerified: result.shopVerified };
    } catch (error) {
      audit(error instanceof OnboardingError ? error.onboardingCode : 'error');
      throw error;
    }
  }

  private async decide(
    taskId: string,
    reviewerId: string,
    input: ReviewResolveRequest,
  ): Promise<{
    status: Outcome;
    shopVerified: boolean;
    kind: DocumentKind;
    correctedFields: string[];
  }> {
    const now = this.clock.now();
    const known = await this.tasks.find(taskId);
    if (!known) throw reviewTaskNotFound();
    // Lock order everywhere: the application, then the task (the verification policy locks the application first too).
    const application = await this.applications.lock(known.shopId);
    const task = await this.tasks.lock(taskId);
    if (!task) throw reviewTaskNotFound();
    const actor = `user:${reviewerId}`;

    if (input.decision === 'REJECT_APPLICATION') {
      if (application?.status === 'VERIFIED') throw alreadyVerified();
      if (application?.status === 'REJECTED') throw taskAlreadyResolved();
    }
    this.assertOpen(task);
    if (!application) throw reviewTaskNotFound();

    switch (input.decision) {
      case 'APPROVE':
        return this.approve(
          task,
          reviewerId,
          actor,
          input.corrections ?? {},
          now,
        );
      case 'REJECT': {
        if (
          !(await this.tasks.resolve({
            id: task.id,
            to: 'REJECTED',
            reviewerId,
            corrections: {},
            now,
          }))
        )
          throw taskAlreadyResolved();
        if (
          !(await this.documents.transition({
            id: task.documentId,
            from: 'NEEDS_REVIEW',
            to: 'REJECTED',
            now,
            rejectionReason: input.reason,
          }))
        )
          throw documentSuperseded();
        await this.history.append({
          entity: 'DOCUMENT',
          entityId: task.documentId,
          shopId: task.shopId,
          fromStatus: 'NEEDS_REVIEW',
          toStatus: 'REJECTED',
          actor,
          at: now,
        });
        await this.events.append(
          OnboardingDocumentRejected.create(
            task.shopId,
            outcomeVersion(application.submissionNo),
            {
              shopId: task.shopId,
              documentId: task.documentId,
              kind: task.kind,
              reason: input.reason,
            },
          ),
          assertActiveTransaction(),
        );
        return {
          status: 'REJECTED',
          shopVerified: false,
          kind: task.kind,
          correctedFields: [],
        };
      }
      case 'REJECT_APPLICATION': {
        if (
          !(await this.applications.reject({
            shopId: task.shopId,
            at: now,
            reasonCode: input.reasonCode,
            reason: input.reason,
          }))
        )
          throw taskAlreadyResolved();
        await this.history.append({
          entity: 'APPLICATION',
          entityId: task.shopId,
          shopId: task.shopId,
          fromStatus: 'SUBMITTED',
          toStatus: 'REJECTED',
          actor,
          reasonCode: input.reasonCode,
          at: now,
        });
        await this.tasks.cancelForShop(task.shopId);
        await this.events.append(
          ShopRejected.create(
            task.shopId,
            outcomeVersion(application.submissionNo),
            {
              shopId: task.shopId,
              submissionNo: application.submissionNo,
              rejectedAt: now.toISOString(),
              reasonCode: input.reasonCode,
            },
          ),
          assertActiveTransaction(),
        );
        await this.retention.schedulePurge(
          task.shopId,
          application.submissionNo,
          now,
        );
        return {
          status: 'APPLICATION_REJECTED',
          shopVerified: false,
          kind: task.kind,
          correctedFields: [],
        };
      }
    }
  }

  private async approve(
    task: ReviewTaskForResolve,
    reviewerId: string,
    actor: string,
    corrections: Partial<Record<string, string>>,
    now: Date,
  ) {
    const allowed = FIELDS[task.kind];
    const unknown = Object.keys(corrections).filter(
      (f) => !allowed.includes(f),
    );
    if (unknown.length > 0)
      throw validationFailed(
        unknown.map((f) => ({
          path: `corrections.${f.slice(0, 60)}`,
          message: 'Unknown field',
        })),
      );

    const latest = await this.attempts.latest(task.documentId);
    const extracted = latest
      ? (JSON.parse(
          this.secrets.open(
            latest.sealedFields,
            sealContext(task.documentId, latest.attempt),
          ),
        ) as Extraction | null)
      : null;
    const values: Record<string, string | null> = Object.fromEntries(
      allowed.map((f) => [f, extracted?.fields?.[f as never]?.value ?? null]),
    );
    const diff: Record<
      string,
      { extracted: string | null; corrected: string }
    > = {};
    for (const [field, corrected] of Object.entries(corrections)) {
      if (corrected === undefined) continue;
      if (values[field] !== corrected)
        diff[field] = {
          extracted: this.show(field, values[field]),
          corrected: this.show(field, corrected) as string,
        };
      values[field] = corrected;
    }

    // A human cannot approve what the hard checks reject (AS-42).
    if (KEY_FIELDS[task.kind].some((f) => !values[f]?.trim()))
      throw missingFields();
    if (task.kind === 'BANK_STATEMENT' && !isValidIban(values.iban!))
      throw ibanInvalid();
    if (
      task.kind === 'VAT_CERTIFICATE' &&
      !isValidVat(
        (values.country ?? task.country ?? '').toUpperCase(),
        values.vatNumber!,
      )
    )
      throw vatInvalid();

    const attempt = (latest?.attempt ?? 0) + 1;
    const final: Extraction = {
      documentType: task.kind,
      legible: true,
      fields: Object.fromEntries(
        Object.entries(values).map(([f, v]) => [
          f,
          { value: v, confidence: 'high', evidence: null },
        ]),
      ) as Extraction['fields'],
    };
    await this.attempts.insert({
      documentId: task.documentId,
      attempt,
      model: 'human',
      promptVersion: PROMPT_VERSION,
      fields: masked(final),
      sealedFields: this.secrets.seal(
        JSON.stringify(final),
        sealContext(task.documentId, attempt),
      ),
      issues: [],
      outcome: 'ACCEPTED',
      inputTokens: 0,
      outputTokens: 0,
      now,
    });
    if (
      !(await this.tasks.resolve({
        id: task.id,
        to: 'APPROVED',
        reviewerId,
        corrections: diff,
        now,
      }))
    )
      throw taskAlreadyResolved();
    if (
      !(await this.documents.transition({
        id: task.documentId,
        from: 'NEEDS_REVIEW',
        to: 'APPROVED',
        now,
      }))
    )
      throw documentSuperseded();
    await this.history.append({
      entity: 'DOCUMENT',
      entityId: task.documentId,
      shopId: task.shopId,
      fromStatus: 'NEEDS_REVIEW',
      toStatus: 'APPROVED',
      actor,
      at: now,
    });
    const shopVerified = await this.verification.evaluate(task.shopId);
    return {
      status: 'APPROVED' as const,
      shopVerified,
      kind: task.kind,
      correctedFields: Object.keys(diff),
    };
  }

  /** A task that is not open is a refusal: decided by someone, or cancelled with its document. */
  private assertOpen(task: ReviewTaskForResolve): void {
    if (task.status === 'APPROVED' || task.status === 'REJECTED')
      throw taskAlreadyResolved();
    if (task.status === 'CANCELLED' || task.documentStatus !== 'NEEDS_REVIEW')
      throw documentSuperseded();
  }

  private show(field: string, value: string | null): string | null {
    return SENSITIVE_FIELDS.has(field) && value ? maskIban(value) : value;
  }

  private async toItem(
    row: ReviewQueueRow,
    names: Map<string, { name: string }>,
    reviewerId: string,
  ): Promise<ReviewQueuePage['items'][number]> {
    let fileUrl: string | null = null;
    if (!row.purgedAt) {
      fileUrl = await this.storage.presignGet(row.storageKey, {
        expiresInSec: LINK_SECONDS,
      });
      this.audit.record({
        event: 'review.file_link',
        reviewerId,
        taskId: row.id,
        shopId: row.shopId,
        decision: 'LINK',
        outcome: 'accepted',
      });
    }
    const view = (row.fields ?? {}) as {
      fields?: ReviewQueuePage['items'][number]['fields'];
    };
    return {
      id: row.id,
      documentId: row.documentId,
      shopId: row.shopId,
      shopName: names.get(row.shopId)?.name ?? null,
      kind: row.kind,
      reasons: row.reasons,
      model: row.model,
      fields: view.fields ?? {},
      attempts: row.attempts,
      fileUrl,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The age of the oldest open task, for the alarm (0 when the queue is empty). */
  private async refreshQueueAge(): Promise<void> {
    const oldest = await this.tasks.oldestOpen();
    onboardingMetrics.queueOldestAge.set(
      oldest
        ? Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000)
        : 0,
    );
  }
}
