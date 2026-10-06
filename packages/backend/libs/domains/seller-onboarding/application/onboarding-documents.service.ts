import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { DocumentKind } from '../domain/questionnaire';

export const EXTRACTION_QUEUE = 'onboarding-documents';

/** What the vision/PDF input of the model accepts; size caps keep requests well under API limits. */
export const ACCEPTED_TYPES: Record<string, number> = {
  'application/pdf': 10 * 1024 * 1024,
  'image/jpeg': 5 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'image/webp': 5 * 1024 * 1024,
};

export interface ShopDocumentRow {
  id: string;
  shopId: string;
  kind: DocumentKind;
  contentType: string;
  contentHash: string;
  storageKey: string;
  status: string;
  rejectionReason: string | null;
  purgedAt: Date | null;
}

/**
 * KYC uploads: presigned PUT pinned to the declared SHA-256 and size, then
 * `uploaded` queues extraction. The same file for the same document kind is
 * the same row (unique content hash) → never extracted (or billed) twice.
 */
@Injectable()
export class OnboardingDocumentsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
  ) {}

  async requestUpload(shopId: string, kind: DocumentKind, sha256: string, size: number, contentType: string) {
    const max = ACCEPTED_TYPES[contentType];
    if (!max) throw new BadRequestException(`Unsupported file type ${contentType}`);
    if (size > max) throw new BadRequestException(`File too large (max ${max / 1024 / 1024} MB)`);
    const [submitted] = await this.sequelize.query(`SELECT 1 FROM "ShopOnboarding" WHERE "shopId" = :shopId`, { type: QueryTypes.SELECT, replacements: { shopId } });
    // Extraction cross-checks documents against the answers, so the questionnaire comes first.
    if (!submitted) throw new ConflictException('Submit the onboarding questionnaire first');

    const id = uuidv7();
    const [created] = await this.sequelize.query<ShopDocumentRow>(
      `INSERT INTO "ShopDocument" (id, "shopId", kind, "contentType", "contentHash", "storageKey")
       VALUES (:id, :shopId, :kind, :contentType, :sha256, :storageKey)
       ON CONFLICT ("shopId", kind, "contentHash") DO NOTHING RETURNING *`,
      { type: QueryTypes.SELECT, replacements: { id, shopId, kind, contentType, sha256, storageKey: `kyc/${shopId}/${id}` } },
    );
    const document = created ?? (await this.byHash(shopId, kind, sha256));
    const upload = document.status === 'AWAITING_UPLOAD' ? await this.storage.presignPutChecked(document.storageKey, sha256, size) : null;
    return { document: publicView(document), deduplicated: !created, upload };
  }

  async uploaded(shopId: string, documentId: string) {
    const doc = await this.get(shopId, documentId);
    if (doc.status !== 'AWAITING_UPLOAD') return publicView(doc);
    if (!(await this.storage.head(doc.storageKey))) throw new BadRequestException('Upload not found');
    await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(`UPDATE "ShopDocument" SET status = 'QUEUED', "updatedAt" = now() WHERE id = :id AND status = 'AWAITING_UPLOAD'`, { transaction, replacements: { id: doc.id } });
      // A new upload replaces earlier unresolved/rejected ones of the same kind.
      await this.sequelize.query(
        `UPDATE "ShopDocument" SET status = 'SUPERSEDED', "updatedAt" = now()
         WHERE "shopId" = :shopId AND kind = :kind AND id <> :id AND status IN ('QUEUED', 'NEEDS_REVIEW', 'REJECTED')`,
        { transaction, replacements: { shopId, kind: doc.kind, id: doc.id } },
      );
    });
    await this.queue.enqueue(EXTRACTION_QUEUE, { documentId: doc.id });
    return publicView({ ...doc, status: 'QUEUED' });
  }

  /** Sellers see statuses and rejection reasons - never extracted values. */
  async list(shopId: string) {
    const rows = await this.sequelize.query<ShopDocumentRow>(`SELECT * FROM "ShopDocument" WHERE "shopId" = :shopId AND status <> 'SUPERSEDED' ORDER BY "createdAt" DESC`, {
      type: QueryTypes.SELECT,
      replacements: { shopId },
    });
    return rows.map(publicView);
  }

  private async get(shopId: string, documentId: string): Promise<ShopDocumentRow> {
    const [doc] = await this.sequelize.query<ShopDocumentRow>(`SELECT * FROM "ShopDocument" WHERE id = :documentId AND "shopId" = :shopId`, {
      type: QueryTypes.SELECT,
      replacements: { documentId, shopId },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  private async byHash(shopId: string, kind: DocumentKind, sha256: string): Promise<ShopDocumentRow> {
    const [doc] = await this.sequelize.query<ShopDocumentRow>(`SELECT * FROM "ShopDocument" WHERE "shopId" = :shopId AND kind = :kind AND "contentHash" = :sha256`, {
      type: QueryTypes.SELECT,
      replacements: { shopId, kind, sha256 },
    });
    return doc;
  }
}

const publicView = (d: ShopDocumentRow) => ({ id: d.id, kind: d.kind, status: d.status, rejectionReason: d.rejectionReason });
