import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { requiredDocuments, type DocumentKind } from '../domain/questionnaire';
import {
  alreadyVerified,
  documentAlreadyApproved,
  documentLimitReached,
  documentNotFound,
  documentNotRequired,
  resubmissionRequired,
  submissionRequired,
  uploadMismatch,
  uploadNotReceived,
} from '../domain/errors';
import {
  APPLICATIONS,
  DOCUMENTS,
  REVIEW_TASKS,
  STATUS_HISTORY,
  type ApplicationRecord,
  type ApplicationRepository,
  type DocumentRecord,
  type DocumentRepository,
  type DocumentView,
  type ReviewTaskRepository,
  type StatusHistoryRepository,
} from '../domain/ports';
import { OnboardingLimits } from './onboarding-limits';

export const EXTRACTION_QUEUE = 'onboarding-documents';
export const EXTRACT_DOCUMENT_TASK = 'onboarding.extract_document';

/** At most this many distinct documents of one kind per round, superseded ones included (FR-012). */
export const MAX_DOCUMENTS_PER_KIND = 5;
/** The grant of a presigned upload (FR-011). */
const GRANT_SECONDS = 900;

/** The message body of the extraction command, validated where it is created (L-001) and where it is read. */
export const extractDocumentBody = z.strictObject({ documentId: z.uuid() });

export interface UploadRequest {
  kind: DocumentKind;
  sha256: string;
  size: number;
  contentType: string;
}

export interface UploadResult {
  document: DocumentView;
  deduplicated: boolean;
  upload: {
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  } | null;
}

const publicView = (d: DocumentRecord): DocumentView => ({
  id: d.id,
  kind: d.kind,
  status: d.status,
  rejectionReason: d.rejectionReason,
});

/**
 * KYC uploads (S04 FR-010…FR-015): a presigned PUT pinned to the declared SHA-256 and size, then `uploaded` queues
 * extraction through the outbox in the confirming transaction (no dual write). Every gate that depends on the
 * application runs under its row lock, so racing requests see one consistent count. The same file in the same round is
 * the same row, so a file is never extracted - or billed - twice. No storage call happens inside a transaction.
 */
@Injectable()
export class OnboardingDocumentsService {
  constructor(
    @Inject(APPLICATIONS) private readonly applications: ApplicationRepository,
    @Inject(DOCUMENTS) private readonly documents: DocumentRepository,
    @Inject(REVIEW_TASKS) private readonly tasks: ReviewTaskRepository,
    @Inject(STATUS_HISTORY) private readonly history: StatusHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly storage: ObjectStorage,
    private readonly outbox: OutboxService,
    private readonly limits: OnboardingLimits,
  ) {}

  async requestUpload(
    shopId: string,
    userId: string,
    request: UploadRequest,
  ): Promise<UploadResult> {
    await this.limits.take('onboarding.upload.shop', shopId);
    const now = this.clock.now();
    const id = uuidv7();

    const { document, created } = await this.transactions.run(async () => {
      const application = await this.applications.lock(shopId);
      this.assertOpen(application, request.kind);

      const existing = await this.documents.findByHash(
        shopId,
        application.submissionNo,
        request.kind,
        request.sha256,
      );
      if (existing) return { document: existing, created: false };

      const approved = await this.documents.approvedKinds(
        shopId,
        application.submissionNo,
      );
      if (approved.includes(request.kind)) throw documentAlreadyApproved();
      if (
        (await this.documents.countOfKind(
          shopId,
          application.submissionNo,
          request.kind,
        )) >= MAX_DOCUMENTS_PER_KIND
      )
        throw documentLimitReached();

      const inserted = await this.documents.insertAwaiting({
        id,
        shopId,
        submissionNo: application.submissionNo,
        kind: request.kind,
        contentType: request.contentType,
        contentHash: request.sha256,
        size: request.size,
        storageKey: `kyc/${shopId}/${id}`,
        now,
      });
      if (!inserted) {
        // cannot happen under the application lock; answer as a de-duplicated request rather than fail
        const raced = await this.documents.findByHash(
          shopId,
          application.submissionNo,
          request.kind,
          request.sha256,
        );
        return { document: raced!, created: false };
      }
      await this.history.append({
        entity: 'DOCUMENT',
        entityId: inserted.id,
        shopId,
        fromStatus: null,
        toStatus: 'AWAITING_UPLOAD',
        actor: `user:${userId}`,
        at: now,
      });
      return { document: inserted, created: true };
    });

    const grant =
      document.status === 'AWAITING_UPLOAD'
        ? await this.storage.presignPutChecked(
            document.storageKey,
            document.contentHash,
            document.size ?? request.size,
            GRANT_SECONDS,
          )
        : null;
    return {
      document: publicView(document),
      deduplicated: !created,
      upload: grant
        ? {
            url: grant.url,
            method: 'PUT',
            headers: grant.headers,
            expiresAt: new Date(
              now.getTime() + GRANT_SECONDS * 1000,
            ).toISOString(),
          }
        : null,
    };
  }

  async uploaded(
    shopId: string,
    userId: string,
    documentId: string,
  ): Promise<DocumentView> {
    const doc = await this.documents.find(shopId, documentId);
    if (!doc) throw documentNotFound();
    if (doc.status !== 'AWAITING_UPLOAD') return publicView(doc);

    const head = await this.storage.head(doc.storageKey);
    if (!head) throw uploadNotReceived();
    if (head.size !== doc.size) {
      await this.storage.delete(doc.storageKey);
      throw uploadMismatch();
    }

    const now = this.clock.now();
    return this.transactions.run(async () => {
      await this.applications.lock(shopId); // serializes confirmations of one shop
      const won = await this.documents.transition({
        id: doc.id,
        from: 'AWAITING_UPLOAD',
        to: 'QUEUED',
        now,
      });
      if (!won) {
        const current = await this.documents.find(shopId, documentId);
        return publicView(current ?? doc);
      }
      const superseded = await this.documents.supersedeSiblings({
        shopId,
        submissionNo: doc.submissionNo,
        kind: doc.kind,
        keepId: doc.id,
        now,
      });
      await this.tasks.cancelForDocuments(superseded.map((d) => d.id));
      await this.history.append([
        {
          entity: 'DOCUMENT',
          entityId: doc.id,
          shopId,
          fromStatus: 'AWAITING_UPLOAD',
          toStatus: 'QUEUED',
          actor: `user:${userId}`,
          at: now,
        },
        ...superseded.map((d) => ({
          entity: 'DOCUMENT' as const,
          entityId: d.id,
          shopId,
          fromStatus: d.fromStatus as string,
          toStatus: 'SUPERSEDED',
          actor: `user:${userId}`,
          at: now,
        })),
      ]);
      await this.outbox.appendTask({
        queue: EXTRACTION_QUEUE,
        type: EXTRACT_DOCUMENT_TASK,
        aggregateId: doc.id,
        body: extractDocumentBody.parse({ documentId: doc.id }),
      });
      return publicView({ ...doc, status: 'QUEUED' });
    });
  }

  /** The gates of a request that depend on the application (FR-010). */
  private assertOpen(
    application: ApplicationRecord | null,
    kind: DocumentKind,
  ): asserts application is ApplicationRecord {
    if (!application) throw submissionRequired();
    if (application.status === 'VERIFIED') throw alreadyVerified();
    if (application.status === 'REJECTED') throw resubmissionRequired();
    if (!requiredDocuments(application.answers).includes(kind))
      throw documentNotRequired();
  }
}
