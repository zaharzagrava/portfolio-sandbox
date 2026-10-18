import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { assertActiveTransaction } from '@app/infrastructure/context/transaction-scope';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  AnswersSchema,
  fieldIssues,
  requiredDocuments,
  STEP_NAMES,
  STEPS,
  type Answers,
  type DocumentKind,
  type FieldIssue,
  type StepName,
} from '../domain/questionnaire';
import { alreadySubmitted, validationFailed } from '../domain/errors';
import {
  APPLICATIONS,
  DOCUMENTS,
  DRAFTS,
  REVIEW_TASKS,
  STATUS_HISTORY,
  type ApplicationRecord,
  type ApplicationRepository,
  type DocumentRepository,
  type DocumentView,
  type DraftStore,
  type ReviewTaskRepository,
  type StatusHistoryRepository,
} from '../domain/ports';
import {
  OnboardingSubmitted,
  submittedVersion,
} from './events/onboarding-events';
import { OnboardingLimits } from './onboarding-limits';
import { onboardingMetrics } from './onboarding-metrics';

export interface SubmitResult {
  submitted: true;
  submissionNo: number;
  requiredDocuments: DocumentKind[];
}

export interface OnboardingViewResult {
  status: 'NOT_STARTED' | 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
  submissionNo: number | null;
  answers: Partial<Answers>;
  missingSteps: StepName[];
  requiredDocuments: Array<{
    kind: DocumentKind;
    status: 'MISSING' | Exclude<DocumentView['status'], 'SUPERSEDED'>;
  }> | null;
  documents: DocumentView[];
}

/** A zod failure as the `{path, message}` list; the root of a body is called `body`. */
const toIssues = (error: Parameters<typeof fieldIssues>[0], prefix?: string) =>
  fieldIssues(error, prefix).map((i): FieldIssue => ({
    ...i,
    path: i.path || 'body',
  }));

/**
 * The questionnaire (S04 FR-001…FR-005). Drafts live in a Redis hash (one field per step, 7-day sliding lifetime) - no
 * relational row exists before the submit. Submit re-validates the whole set and writes the application row, its
 * history row and the outbox event in ONE transaction under the application row lock; the draft is dropped only after
 * that commits. The shop's own tables are never written (FR-060): tenancy follows `shop.onboarding_submitted`.
 */
@Injectable()
export class OnboardingSessionService {
  constructor(
    @Inject(APPLICATIONS) private readonly applications: ApplicationRepository,
    @Inject(DOCUMENTS) private readonly documents: DocumentRepository,
    @Inject(REVIEW_TASKS) private readonly tasks: ReviewTaskRepository,
    @Inject(STATUS_HISTORY) private readonly history: StatusHistoryRepository,
    @Inject(DRAFTS) private readonly drafts: DraftStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly events: OutboxService,
    private readonly limits: OnboardingLimits,
  ) {}

  async saveStep(
    shopId: string,
    step: string,
    body: unknown,
  ): Promise<OnboardingViewResult> {
    if (!(STEP_NAMES as string[]).includes(step))
      throw validationFailed([{ path: 'step', message: 'Unknown step' }]);
    const name = step as StepName;
    const parsed = STEPS[name].safeParse(body);
    if (!parsed.success) throw validationFailed(toIssues(parsed.error));

    const application = await this.applications.find(shopId);
    if (application && application.status !== 'REJECTED')
      throw alreadySubmitted();
    // After a rejection the first save seeds the draft from the last answers (FR-005).
    const seed = application ? { ...application.answers } : null;
    await this.drafts.saveStep(shopId, name, parsed.data, seed);
    return this.view(shopId);
  }

  async view(shopId: string): Promise<OnboardingViewResult> {
    const application = await this.applications.find(shopId);
    const draft = this.known(await this.drafts.read(shopId));
    const submittedNow =
      application && application.status !== 'REJECTED' ? application : null;
    const answers: Partial<Answers> = submittedNow
      ? submittedNow.answers
      : Object.keys(draft).length > 0 || !application
        ? draft
        : application!.answers;
    const status: OnboardingViewResult['status'] = application
      ? application.status
      : Object.keys(draft).length > 0
        ? 'DRAFT'
        : 'NOT_STARTED';

    const documents = application
      ? await this.documents.listVisible(shopId, application.submissionNo)
      : [];
    return {
      status,
      submissionNo: application?.submissionNo ?? null,
      answers,
      missingSteps: submittedNow ? [] : STEP_NAMES.filter((s) => !answers[s]),
      requiredDocuments: application
        ? requiredDocuments(application.answers).map((kind) => ({
            kind,
            status: this.progressOf(kind, documents),
          }))
        : null,
      documents,
    };
  }

  async submit(shopId: string, userId: string): Promise<SubmitResult> {
    const existing = await this.applications.find(shopId);
    if (existing && existing.status !== 'REJECTED')
      return this.outcome(existing); // a repeated submit: the stored outcome, no limit consumed

    await this.limits.take('onboarding.submit.shop', shopId);

    const draft = this.known(await this.drafts.read(shopId));
    const parsed = AnswersSchema.safeParse(draft);
    if (!parsed.success) {
      // a retry after the draft was consumed by a racing submit
      const raced = await this.applications.find(shopId);
      if (raced && raced.status !== 'REJECTED') return this.outcome(raced);
      throw validationFailed(
        toIssues(parsed.error),
        STEP_NAMES.filter((s) => !draft[s]),
      );
    }

    const now = this.clock.now();
    const stored = await this.transactions.run(async () => {
      const tx = assertActiveTransaction();
      const current = await this.applications.lock(shopId);
      let submissionNo: number;
      if (!current) {
        if (
          !(await this.applications.insert({
            shopId,
            answers: parsed.data,
            submittedBy: userId,
            now,
          }))
        )
          return null; // a racing submit won the insert
        submissionNo = 1;
        await this.history.append({
          entity: 'APPLICATION',
          entityId: shopId,
          shopId,
          fromStatus: null,
          toStatus: 'SUBMITTED',
          actor: `user:${userId}`,
          at: now,
        });
      } else if (current.status === 'REJECTED') {
        const next = await this.applications.resubmit({
          shopId,
          answers: parsed.data,
          submittedBy: userId,
          now,
        });
        if (next === null) return null;
        submissionNo = next;
        const superseded = await this.documents.supersedeRound({
          shopId,
          submissionNo: current.submissionNo,
          now,
        });
        await this.tasks.cancelForDocuments(superseded.map((d) => d.id));
        await this.history.append([
          ...superseded.map((d) => ({
            entity: 'DOCUMENT' as const,
            entityId: d.id,
            shopId,
            fromStatus: d.fromStatus as string,
            toStatus: 'SUPERSEDED',
            actor: `user:${userId}`,
            at: now,
          })),
          {
            entity: 'APPLICATION' as const,
            entityId: shopId,
            shopId,
            fromStatus: 'REJECTED',
            toStatus: 'SUBMITTED',
            actor: `user:${userId}`,
            at: now,
          },
        ]);
      } else {
        return null; // submitted or verified meanwhile
      }
      const required = requiredDocuments(parsed.data);
      await this.events.append(
        OnboardingSubmitted.create(shopId, submittedVersion(submissionNo), {
          shopId,
          submissionNo,
          country: parsed.data.business.country,
          legalForm: parsed.data.business.legalForm,
          requiredDocuments: required,
        }),
        tx,
      );
      return {
        submitted: true as const,
        submissionNo,
        requiredDocuments: required,
      };
    });

    if (stored) {
      onboardingMetrics.applicationDecisions.add(1, { decision: 'submitted' });
      await this.drafts.delete(shopId);
      return stored;
    }
    const winner = await this.applications.find(shopId);
    if (!winner) throw alreadySubmitted();
    return this.outcome(winner);
  }

  private outcome(application: ApplicationRecord): SubmitResult {
    return {
      submitted: true,
      submissionNo: application.submissionNo,
      requiredDocuments: requiredDocuments(application.answers),
    };
  }

  /** Only the four known steps: a stray hash field is never shown or submitted. */
  private known(raw: Record<string, unknown>): Partial<Answers> {
    return Object.fromEntries(
      STEP_NAMES.filter((s) => raw[s] !== undefined).map((s) => [s, raw[s]]),
    ) as Partial<Answers>;
  }

  /** The best status among the visible documents of a kind: an approved one wins, else the newest. */
  private progressOf(
    kind: DocumentKind,
    documents: DocumentView[],
  ): 'MISSING' | Exclude<DocumentView['status'], 'SUPERSEDED'> {
    const ofKind = documents.filter((d) => d.kind === kind);
    const best = ofKind.find((d) => d.status === 'APPROVED') ?? ofKind[0];
    return (
      (best?.status as Exclude<DocumentView['status'], 'SUPERSEDED'>) ??
      'MISSING'
    );
  }
}
