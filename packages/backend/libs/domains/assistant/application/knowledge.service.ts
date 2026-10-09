import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, UniqueConstraintError } from 'sequelize';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { Readable } from 'node:stream';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  chunkSections,
  chunkText,
  markdownSections,
  pdfSections,
  Section,
} from '../domain/chunker';
import { Embedder, toVectorLiteral } from '../infra/embedder';

export const INGEST_QUEUE = 'knowledge-ingest';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 2_000;
const INSERT_BATCH = 200;

export type Visibility = 'PUBLIC' | 'SHOP_PRIVATE' | 'PLATFORM';

export interface KnowledgeDocumentRow {
  id: string;
  shopId: string | null;
  productId: string | null;
  visibility: Visibility;
  title: string;
  format: 'MARKDOWN' | 'PDF';
  storageKey: string;
  contentHash: string | null;
  status: string;
  error: string | null;
  chunkCount: number;
  indexedHash: string | null;
}

export interface NewDocument {
  shopId: string | null;
  productId?: string | null;
  visibility: Visibility;
  title: string;
  createdBy: string;
}

/** Errors that will fail the same way on every retry - mark FAILED, don't burn SQS retries. */
class PoisonDocumentError extends Error {}

/**
 * Knowledge documents (SD-43): create (markdown inline or PDF via a
 * checksum-pinned presigned PUT) → SQS → parse → structure-aware chunks →
 * batched embeddings → pgvector + FTS, replaced atomically per document.
 *
 * Idempotency: the same bytes in the same scope are the same document
 * (unique index on the content hash); a redelivered ingest of an
 * already-indexed hash is a no-op.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly embedder: Embedder,
  ) {}

  async createMarkdown(
    doc: NewDocument,
    markdown: string,
  ): Promise<{ document: KnowledgeDocumentRow; deduplicated: boolean }> {
    if (!markdown.trim()) throw new BadRequestException('Empty document');
    if (Buffer.byteLength(markdown) > MAX_BYTES)
      throw new BadRequestException('Document too large');
    await this.assertProductInShop(doc);
    const hash = sha256(markdown);
    const existing = await this.findByHash(doc, hash);
    if (existing) return { document: existing, deduplicated: true };

    let document: KnowledgeDocumentRow;
    try {
      document = await this.insert(doc, 'MARKDOWN', hash, 'QUEUED');
    } catch (error) {
      return {
        document: await this.onRace(error, doc, hash),
        deduplicated: true,
      };
    }
    await this.storage.put(
      document.storageKey,
      Buffer.from(markdown),
      'text/markdown; charset=utf-8',
    );
    await this.queue.enqueue(INGEST_QUEUE, { documentId: document.id });
    return { document, deduplicated: false };
  }

  /** PDF: the client uploads straight to S3; the PUT is pinned to the declared SHA-256 and size. */
  async createPdf(doc: NewDocument, sha256Hex: string, size: number) {
    if (size > MAX_BYTES) throw new BadRequestException('Document too large');
    await this.assertProductInShop(doc);
    let document = await this.findByHash(doc, sha256Hex);
    const deduplicated = !!document;
    if (!document) {
      try {
        document = await this.insert(doc, 'PDF', sha256Hex, 'AWAITING_UPLOAD');
      } catch (error) {
        document = await this.onRace(error, doc, sha256Hex);
      }
    }
    // Still waiting for its bytes (first client gave up?): anyone re-uploading the same file gets a fresh URL for the same key.
    const upload =
      document.status === 'AWAITING_UPLOAD'
        ? await this.storage.presignPutChecked(
            document.storageKey,
            sha256Hex,
            size,
          )
        : null;
    return { document, deduplicated, upload };
  }

  async uploaded(
    shopId: string | null,
    documentId: string,
  ): Promise<KnowledgeDocumentRow> {
    const doc = await this.get(shopId, documentId);
    if (doc.status !== 'AWAITING_UPLOAD') return doc;
    if (!(await this.storage.head(doc.storageKey)))
      throw new BadRequestException('Upload not found');
    await this.sequelize.query(
      `UPDATE "KnowledgeDocument" SET status = 'QUEUED', "updatedAt" = now() WHERE id = :id AND status = 'AWAITING_UPLOAD'`,
      { replacements: { id: doc.id } },
    );
    await this.queue.enqueue(INGEST_QUEUE, { documentId: doc.id });
    return { ...doc, status: 'QUEUED' };
  }

  async list(shopId: string | null): Promise<KnowledgeDocumentRow[]> {
    return this.sequelize.query<KnowledgeDocumentRow>(
      `SELECT * FROM "KnowledgeDocument" WHERE "shopId" IS NOT DISTINCT FROM :shopId AND status <> 'DELETED' ORDER BY "createdAt" DESC LIMIT 200`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
  }

  async get(
    shopId: string | null,
    documentId: string,
  ): Promise<KnowledgeDocumentRow> {
    const [doc] = await this.sequelize.query<KnowledgeDocumentRow>(
      `SELECT * FROM "KnowledgeDocument" WHERE id = :documentId AND "shopId" IS NOT DISTINCT FROM :shopId AND status <> 'DELETED'`,
      { type: QueryTypes.SELECT, replacements: { documentId, shopId } },
    );
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  /** Chunks go in the same transaction as the status flip: a deleted document is unsearchable the moment the call returns. */
  async delete(shopId: string | null, documentId: string): Promise<void> {
    const doc = await this.get(shopId, documentId);
    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(
        `UPDATE "KnowledgeDocument" SET status = 'DELETED', "updatedAt" = now() WHERE id = :id`,
        { replacements: { id: doc.id }, transaction },
      );
      await this.sequelize.query(
        `DELETE FROM "KnowledgeChunk" WHERE "documentId" = :id`,
        { replacements: { id: doc.id }, transaction },
      );
    });
    await this.storage
      .delete(doc.storageKey)
      .catch((e) =>
        this.logger.warn(`orphaned object ${doc.storageKey}: ${e.message}`),
      );
  }

  /** SQS handler. Re-delivery safe: whole-document replace, and an already-indexed hash is skipped. */
  async ingest(documentId: string): Promise<void> {
    const [doc] = await this.sequelize.query<KnowledgeDocumentRow>(
      `UPDATE "KnowledgeDocument" SET status = 'PROCESSING', "updatedAt" = now()
       WHERE id = :documentId AND status IN ('QUEUED', 'PROCESSING', 'FAILED') AND "indexedHash" IS DISTINCT FROM "contentHash"
       RETURNING *`,
      { type: QueryTypes.SELECT, replacements: { documentId } },
    );
    if (!doc) return; // deleted, still awaiting upload, or this exact content is already indexed

    try {
      const bytes = await this.read(doc.storageKey);
      const sections = await this.sections(doc, bytes);
      const chunks = chunkSections(sections);
      if (!chunks.length)
        throw new PoisonDocumentError(
          'No extractable text (scanned PDF without OCR?)',
        );
      if (chunks.length > MAX_CHUNKS)
        throw new PoisonDocumentError(
          `Too many chunks (${chunks.length} > ${MAX_CHUNKS})`,
        );

      const embeddings = await this.embedder.embed(
        chunks.map(chunkText),
        'document',
      );

      // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
      await this.sequelize.transaction(async (transaction) => {
        await this.sequelize.query(
          `DELETE FROM "KnowledgeChunk" WHERE "documentId" = :id`,
          { replacements: { id: doc.id }, transaction },
        );
        for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
          const batch = chunks.slice(i, i + INSERT_BATCH);
          const replacements: Record<string, unknown> = {
            documentId: doc.id,
            shopId: doc.shopId,
            productId: doc.productId,
            visibility: doc.visibility,
          };
          const values = batch.map((c, j) => {
            Object.assign(replacements, {
              [`o${j}`]: c.ordinal,
              [`h${j}`]: c.headingPath,
              [`p${j}`]: c.page,
              [`c${j}`]: c.content,
              [`t${j}`]: c.tokens,
              [`e${j}`]: toVectorLiteral(embeddings[i + j]),
            });
            return `(:documentId, :shopId, :productId, :visibility, :o${j}, :h${j}, :p${j}, :c${j}, :t${j}, CAST(:e${j} AS halfvec))`;
          });
          await this.sequelize.query(
            `INSERT INTO "KnowledgeChunk" ("documentId", "shopId", "productId", visibility, ordinal, "headingPath", page, content, tokens, embedding) VALUES ${values.join(', ')}`,
            { replacements, transaction },
          );
        }
        const [, updated] = await this.sequelize.query(
          `UPDATE "KnowledgeDocument" SET status = 'READY', error = NULL, "chunkCount" = :n, "indexedHash" = "contentHash", "embeddingModel" = :model, "updatedAt" = now()
           WHERE id = :id AND status = 'PROCESSING'`,
          {
            replacements: {
              id: doc.id,
              n: chunks.length,
              model: this.embedder.model,
            },
            transaction,
          },
        );
        // Deleted while we were embedding: roll the chunks back.
        if (!(updated as { rowCount: number }).rowCount)
          throw new PoisonDocumentError('document deleted during ingestion');
      });
    } catch (error) {
      const poison = error instanceof PoisonDocumentError;
      await this.sequelize.query(
        `UPDATE "KnowledgeDocument" SET status = 'FAILED', error = :error, "updatedAt" = now() WHERE id = :id AND status = 'PROCESSING'`,
        {
          replacements: {
            id: doc.id,
            error: (error as Error).message.slice(0, 500),
          },
        },
      );
      // Poison documents stop here; provider/network errors go back to SQS for a retry (DLQ after maxReceiveCount).
      if (!poison) throw error;
    }
  }

  private async sections(
    doc: KnowledgeDocumentRow,
    bytes: Buffer,
  ): Promise<Section[]> {
    if (doc.format === 'MARKDOWN')
      return markdownSections(bytes.toString('utf8'), doc.title);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw new PoisonDocumentError('Not a PDF');
    try {
      const { extractText } = await import('unpdf');
      const { text } = await extractText(new Uint8Array(bytes), {
        mergePages: false,
      });
      return pdfSections(text, doc.title);
    } catch (error) {
      throw new PoisonDocumentError(
        `PDF could not be parsed: ${(error as Error).message}`,
      );
    }
  }

  private async read(key: string): Promise<Buffer> {
    const stream: Readable = await this.storage.getStream(key);
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of stream) {
      size += part.length;
      if (size > MAX_BYTES) throw new PoisonDocumentError('Document too large');
      parts.push(part as Buffer);
    }
    return Buffer.concat(parts);
  }

  private async insert(
    doc: NewDocument,
    format: 'MARKDOWN' | 'PDF',
    hash: string,
    status: string,
  ): Promise<KnowledgeDocumentRow> {
    const id = uuidv7();
    const storageKey = `knowledge/${doc.shopId ?? 'platform'}/${id}.${format === 'PDF' ? 'pdf' : 'md'}`;
    const [row] = await this.sequelize.query<KnowledgeDocumentRow>(
      `INSERT INTO "KnowledgeDocument" (id, "shopId", "productId", visibility, title, format, "storageKey", "contentHash", status, "createdBy")
       VALUES (:id, :shopId, :productId, :visibility, :title, :format, :storageKey, :hash, :status, :createdBy)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          id,
          shopId: doc.shopId,
          productId: doc.productId ?? null,
          visibility: doc.visibility,
          title: doc.title,
          format,
          storageKey,
          hash,
          status,
          createdBy: doc.createdBy,
        },
      },
    );
    return row;
  }

  private async findByHash(
    doc: NewDocument,
    hash: string,
  ): Promise<KnowledgeDocumentRow | null> {
    const [row] = await this.sequelize.query<KnowledgeDocumentRow>(
      `SELECT * FROM "KnowledgeDocument" WHERE "shopId" IS NOT DISTINCT FROM :shopId AND "productId" IS NOT DISTINCT FROM :productId
         AND visibility = :visibility AND "contentHash" = :hash AND status <> 'DELETED'`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId: doc.shopId,
          productId: doc.productId ?? null,
          visibility: doc.visibility,
          hash,
        },
      },
    );
    return row ?? null;
  }

  /** Two concurrent uploads of the same bytes: the unique index picks one; the loser returns the winner. */
  private async onRace(
    error: unknown,
    doc: NewDocument,
    hash: string,
  ): Promise<KnowledgeDocumentRow> {
    if (error instanceof UniqueConstraintError) {
      const winner = await this.findByHash(doc, hash);
      if (winner) return winner;
    }
    throw error;
  }

  private async assertProductInShop(doc: NewDocument) {
    if (doc.visibility === 'PLATFORM' && (doc.shopId || doc.productId))
      throw new BadRequestException('Platform documents belong to no shop');
    if (!doc.productId) return;
    if (doc.visibility !== 'PUBLIC')
      throw new BadRequestException('Product documents are public');
    const [row] = await this.sequelize.query<{ shopId: string | null }>(
      `SELECT "shopId" FROM "Product" WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: doc.productId } },
    );
    if (!row) throw new NotFoundException('Product not found');
    if (row.shopId !== doc.shopId)
      throw new ForbiddenException('Product belongs to another shop');
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
