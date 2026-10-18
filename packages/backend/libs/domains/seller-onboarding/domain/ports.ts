import type { Answers, DocumentKind } from './questionnaire';
import type { ApplicationStatus } from './application-status';
import type { DocumentStatus } from './document-status';
import type { ReviewTaskStatus } from './review-task-status';

/**
 * What the application services need from storage (constitution I, R-10). Adapters live in `infra/`. No method takes a
 * transaction: they join the one of the surrounding `TransactionRunner.run` scope (CLS). Every transition is a conditional
 * update that answers whether it won (FR-062); the history row of the same transition is written by the caller through
 * `StatusHistoryRepository` in the same scope. Times come from the injected clock, never from SQL `now()`.
 */

export type RejectionReasonCode =
  'DOCUMENTS_INVALID' | 'IDENTITY_MISMATCH' | 'FRAUD_SUSPECTED' | 'OTHER';

export interface ApplicationRecord {
  shopId: string;
  answers: Answers;
  submittedBy: string;
  submittedAt: Date;
  status: ApplicationStatus;
  submissionNo: number;
  verifiedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReasonCode: RejectionReasonCode | null;
}

export interface ApplicationRepository {
  find(shopId: string): Promise<ApplicationRecord | null>;
  /** `SELECT … FOR UPDATE`: serializes submit, resubmit, upload gates and the verification decision per shop. */
  lock(shopId: string): Promise<ApplicationRecord | null>;
  /** Round 1. `false` when the shop already has an application. */
  insert(input: {
    shopId: string;
    answers: Answers;
    submittedBy: string;
    now: Date;
  }): Promise<boolean>;
  /** `REJECTED → SUBMITTED`, `submissionNo + 1`; the new number, or `null` when the application is not `REJECTED`. */
  resubmit(input: {
    shopId: string;
    answers: Answers;
    submittedBy: string;
    now: Date;
  }): Promise<number | null>;
  /** The shops whose application is `SUBMITTED` and has every document of its round approved (the verify-pending sweep); oldest first. */
  listPendingVerification(limit: number): Promise<string[]>;
  /** `SUBMITTED → VERIFIED`. */
  verify(shopId: string, at: Date): Promise<boolean>;
  /** `SUBMITTED → REJECTED`. */
  reject(input: {
    shopId: string;
    at: Date;
    reasonCode: RejectionReasonCode;
    reason: string;
  }): Promise<boolean>;
  erase(shopId: string): Promise<void>;
}

export interface DocumentRecord {
  id: string;
  shopId: string;
  submissionNo: number;
  kind: DocumentKind;
  contentType: string;
  contentHash: string;
  size: number | null;
  storageKey: string;
  status: DocumentStatus;
  rejectionReason: string | null;
  leaseUntil: Date | null;
  purgedAt: Date | null;
}

export interface ClaimedDocument extends DocumentRecord {
  previousStatus: DocumentStatus;
}

/** The only columns a seller can ever see (A39). */
export interface DocumentView {
  id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  rejectionReason: string | null;
}

export interface SupersededDocument {
  id: string;
  fromStatus: DocumentStatus;
}

export interface DocumentRepository {
  /** `null` when the same file already exists in this round (the caller loads it with `findByHash`). */
  insertAwaiting(input: {
    id: string;
    shopId: string;
    submissionNo: number;
    kind: DocumentKind;
    contentType: string;
    contentHash: string;
    size: number;
    storageKey: string;
    now: Date;
  }): Promise<DocumentRecord | null>;
  findByHash(
    shopId: string,
    submissionNo: number,
    kind: DocumentKind,
    contentHash: string,
  ): Promise<DocumentRecord | null>;
  /** Shop-scoped (FR-063). */
  find(shopId: string, documentId: string): Promise<DocumentRecord | null>;
  /** For workers that only hold the document ID. */
  findById(documentId: string): Promise<DocumentRecord | null>;
  /** The seller's list: current round, `SUPERSEDED` hidden, public columns only. */
  listVisible(shopId: string, submissionNo: number): Promise<DocumentView[]>;
  /** Documents of the round in any status, counting superseded ones (the cap of FR-012). */
  countOfKind(
    shopId: string,
    submissionNo: number,
    kind: DocumentKind,
  ): Promise<number>;
  approvedKinds(shopId: string, submissionNo: number): Promise<DocumentKind[]>;
  /** `from → to` for one document; `patch` sets the rejection reason or clears the lease. */
  transition(input: {
    id: string;
    from: DocumentStatus | DocumentStatus[];
    to: DocumentStatus;
    now: Date;
    rejectionReason?: string;
  }): Promise<boolean>;
  /**
   * `QUEUED → EXTRACTING`, or a lapsed `EXTRACTING` taken over (`leaseUntil <= now`); `null` when somebody else holds it
   * or it is decided. `previousStatus` tells the caller whether a transition happened (history) or a lease was taken over.
   */
  claim(input: {
    id: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ClaimedDocument | null>;
  /** The worker gave up on a claimed document (provider failure): the lease ends now so the redelivery can take it. */
  releaseLease(id: string, now: Date): Promise<boolean>;
  /** The conditional finish of a claimed document: `EXTRACTING → to`, clears the lease. */
  finish(input: {
    id: string;
    to: 'APPROVED' | 'NEEDS_REVIEW';
    now: Date;
  }): Promise<boolean>;
  /** Other unresolved or rejected documents of the kind in the round → `SUPERSEDED` (FR-014). */
  supersedeSiblings(input: {
    shopId: string;
    submissionNo: number;
    kind: DocumentKind;
    keepId: string;
    now: Date;
  }): Promise<SupersededDocument[]>;
  /** A new round: every document of the previous round that is not already superseded. */
  supersedeRound(input: {
    shopId: string;
    submissionNo: number;
    now: Date;
  }): Promise<SupersededDocument[]>;
  /** Raw files still in storage: of a round (`APPROVED`, `REJECTED`, `SUPERSEDED`), or of the shop in any status. */
  listUnpurged(input: {
    shopId: string;
    submissionNo?: number;
  }): Promise<Array<{ id: string; storageKey: string }>>;
  markPurged(id: string, at: Date): Promise<void>;
  /** The shop's documents with their attempts and review tasks (the erase job, AS-61). */
  erase(shopId: string): Promise<void>;
}

export type AttemptOutcome = 'ACCEPTED' | 'ESCALATE' | 'REVIEW';

export interface AttemptRecord {
  documentId: string;
  attempt: number;
  model: string;
  outcome: AttemptOutcome;
  issues: Array<{ field: string | null; code: string; escalate: boolean }>;
  /** Masked view (sensitive values masked, evidence removed). */
  fields: unknown;
  sealedFields: string;
}

export interface AttemptRepository {
  list(documentId: string): Promise<AttemptRecord[]>;
  latest(documentId: string): Promise<AttemptRecord | null>;
  /** `ON CONFLICT (documentId, attempt) DO NOTHING`: a redelivered write is harmless. */
  insert(input: {
    documentId: string;
    attempt: number;
    model: string;
    promptVersion: string;
    fields: unknown;
    sealedFields: string;
    issues: unknown;
    outcome: AttemptOutcome;
    inputTokens: number;
    outputTokens: number;
    now: Date;
  }): Promise<boolean>;
}

export interface ReviewTaskRecord {
  id: string;
  documentId: string;
  shopId: string;
  status: ReviewTaskStatus;
  reasons: Array<{ field: string | null; code: string; escalate: boolean }>;
  createdAt: Date;
}

export interface ReviewQueueRow extends ReviewTaskRecord {
  kind: DocumentKind;
  storageKey: string;
  purgedAt: Date | null;
  model: string | null;
  fields: unknown;
  attempts: number;
}

/** A task with the facts a resolver needs, read under a row lock. */
export interface ReviewTaskForResolve extends ReviewTaskRecord {
  kind: DocumentKind;
  documentStatus: DocumentStatus;
  country: string | null;
}

export interface ReviewTaskRepository {
  /** At most one open task per document; `false` when one exists. */
  open(input: {
    documentId: string;
    shopId: string;
    reasons: unknown;
    now: Date;
  }): Promise<boolean>;
  /** Open tasks of live (`NEEDS_REVIEW`) documents, oldest first by `(createdAt, id)`. */
  page(input: {
    after: { createdAt: Date; id: string } | null;
    limit: number;
    kind: DocumentKind | null;
  }): Promise<ReviewQueueRow[]>;
  find(taskId: string): Promise<ReviewTaskRecord | null>;
  /** `FOR UPDATE OF t`, whatever the task's status; the caller decides which refusal it is. */
  lock(taskId: string): Promise<ReviewTaskForResolve | null>;
  /** `OPEN → APPROVED | REJECTED`. */
  resolve(input: {
    id: string;
    to: 'APPROVED' | 'REJECTED';
    reviewerId: string;
    corrections: unknown;
    now: Date;
  }): Promise<boolean>;
  cancelForDocuments(documentIds: string[]): Promise<number>;
  cancelForShop(shopId: string): Promise<number>;
  oldestOpen(): Promise<Date | null>;
}

export interface StatusHistoryEntry {
  entity: 'APPLICATION' | 'DOCUMENT';
  entityId: string;
  shopId: string;
  fromStatus: string | null;
  toStatus: string;
  /** `system`, `worker` or `user:<uuid>`. */
  actor: string;
  reasonCode?: string | null;
  at: Date;
}

export interface StatusHistoryRepository {
  append(entries: StatusHistoryEntry | StatusHistoryEntry[]): Promise<void>;
  erase(shopId: string): Promise<void>;
}

/** Questionnaire drafts (Redis hash, one field per step, 7-day sliding lifetime). */
export interface DraftStore {
  /** Writes one step and resets the lifetime; `seed` fills the hash first when it does not exist. */
  saveStep(
    shopId: string,
    step: string,
    value: unknown,
    seed: Record<string, unknown> | null,
  ): Promise<void>;
  read(shopId: string): Promise<Record<string, unknown>>;
  delete(shopId: string): Promise<void>;
}

export const APPLICATIONS = Symbol('APPLICATIONS');
export const DOCUMENTS = Symbol('DOCUMENTS');
export const ATTEMPTS = Symbol('ATTEMPTS');
export const REVIEW_TASKS = Symbol('REVIEW_TASKS');
export const STATUS_HISTORY = Symbol('STATUS_HISTORY');
export const DRAFTS = Symbol('DRAFTS');
