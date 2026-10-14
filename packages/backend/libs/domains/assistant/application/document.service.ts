import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type {
  KnowledgeAdminCreateRequest,
  KnowledgeCreateRequest,
  KnowledgeDocument,
  KnowledgeDocumentPage,
  KnowledgeListQuery,
  KnowledgeUploadGrant,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { DEV_KNOWLEDGE_CURSOR_KEY } from '@app/common/config/knowledge-config';
import {
  decodeDocumentCursor,
  encodeDocumentCursor,
} from '../domain/document-cursor';
import {
  documentLimitReached,
  invalidTransition,
  notFound,
  productArchived,
  productDocumentMustBePublic,
  uploadMissing,
} from '../domain/knowledge-errors';
import {
  DOCUMENT_REPOSITORY,
  OBJECT_STORE,
  PRODUCT_DIRECTORY,
  TASK_PUBLISHER,
} from '../domain/ports';
import type {
  DocumentRecord,
  DocumentRepository,
  ObjectStore,
  ProductDirectory,
  TaskPublisher,
} from '../domain/ports';
import { scopeKey } from '../domain/scope';
import type { DocumentScope, Visibility } from '../domain/scope';
import { toDocumentDto } from './document-dto';

export interface CreateResult {
  document: KnowledgeDocument;
  deduplicated: boolean;
  upload?: KnowledgeUploadGrant;
}

const extension = (format: 'MARKDOWN' | 'PDF') =>
  format === 'PDF' ? 'pdf' : 'md';

/**
 * Document management for one scope (a shop, or the platform): create, confirm an upload, retry, delete, list, read
 * (S47 FR-001 – FR-010, FR-012). Every record lookup carries the scope (another scope's document is `404`), every
 * state change is a conditional update (an illegal move is `409`), and the queue task is published after the row exists
 * (a lost publish is repaired by the sweep).
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(TASK_PUBLISHER) private readonly tasks: TaskPublisher,
    @Inject(PRODUCT_DIRECTORY) private readonly products: ProductDirectory,
    private readonly config: ApiConfigService,
  ) {}

  async create(
    scope: DocumentScope,
    userId: string,
    input: KnowledgeCreateRequest | KnowledgeAdminCreateRequest,
  ): Promise<CreateResult & { created: boolean }> {
    const visibility: Visibility =
      scope.kind === 'platform'
        ? 'PLATFORM'
        : (input as KnowledgeCreateRequest).visibility;
    const productId =
      scope.kind === 'shop'
        ? ((input as KnowledgeCreateRequest).productId ?? null)
        : null;
    if (productId && visibility !== 'PUBLIC')
      throw productDocumentMustBePublic();
    if (productId && scope.kind === 'shop')
      await this.assertProductInShop(productId, scope.shopId);

    const isPdf = input.markdown === undefined;
    const bytes = isPdf ? null : Buffer.from(input.markdown as string, 'utf8');
    const contentHash = isPdf
      ? (input.pdfSha256 as string)
      : createHash('sha256').update(bytes!).digest('hex');
    const contentSize = isPdf ? (input.pdfSize as number) : bytes!.length;
    const format = isPdf ? 'PDF' : 'MARKDOWN';

    const existing = await this.documents.findByHash(
      scope,
      productId,
      visibility,
      contentHash,
    );
    if (existing) return this.replay(existing, contentHash, contentSize);

    const id = uuidv7();
    const storageKey = `knowledge/${scope.kind === 'shop' ? scope.shopId : 'platform'}/${id}.${extension(format)}`;
    // Bytes first: a QUEUED row always has its bytes (a lost task is the sweep's to repair, never a lost file).
    if (bytes)
      await this.store.put(storageKey, bytes, 'text/markdown; charset=utf-8');

    const result = await this.documents.insert(
      {
        id,
        scope,
        productId,
        visibility,
        title: input.title,
        format,
        storageKey,
        contentHash,
        contentSize,
        status: isPdf ? 'AWAITING_UPLOAD' : 'QUEUED',
        createdBy: userId,
      },
      scope.kind === 'shop'
        ? this.config.get('knowledge_max_documents_per_shop')
        : null,
    );
    if (result.kind !== 'created') {
      if (bytes) await this.dropBytes(storageKey);
      if (result.kind === 'cap_reached') throw documentLimitReached();
      return this.replay(result.document, contentHash, contentSize);
    }

    const upload = isPdf
      ? await this.grant(result.document, contentHash, contentSize)
      : undefined;
    if (!isPdf) await this.publish(result.document.id);
    return {
      document: toDocumentDto(result.document),
      deduplicated: false,
      created: true,
      ...(upload ? { upload } : {}),
    };
  }

  async uploaded(scope: DocumentScope, id: string): Promise<KnowledgeDocument> {
    const doc = await this.require(scope, id);
    if (doc.status !== 'AWAITING_UPLOAD') return this.settled(doc);
    if (!(await this.store.head(doc.storageKey))) throw uploadMissing();
    const queued = await this.documents.queue(scope, id, 'AWAITING_UPLOAD');
    if (queued) {
      await this.publish(queued.id);
      return toDocumentDto(queued);
    }
    // A concurrent call won the conditional update: answer with what it left behind, queue nothing.
    return this.settled(await this.require(scope, id));
  }

  async retry(scope: DocumentScope, id: string): Promise<KnowledgeDocument> {
    await this.require(scope, id);
    const queued = await this.documents.queue(scope, id, 'FAILED');
    if (!queued) {
      await this.require(scope, id); // gone meanwhile → 404
      throw invalidTransition();
    }
    await this.publish(queued.id);
    return toDocumentDto(queued);
  }

  async get(scope: DocumentScope, id: string): Promise<KnowledgeDocument> {
    return toDocumentDto(await this.require(scope, id));
  }

  async list(
    scope: DocumentScope,
    query: KnowledgeListQuery,
  ): Promise<KnowledgeDocumentPage> {
    const key = this.cursorKey();
    const after = query.cursor
      ? decodeDocumentCursor(key, scopeKey(scope), query.cursor)
      : undefined;
    const page = await this.documents.list(scope, {
      status: query.status,
      limit: query.limit,
      after,
    });
    const last = page.items.at(-1);
    return {
      items: page.items.map(toDocumentDto),
      nextCursor:
        page.hasMore && last
          ? encodeDocumentCursor(key, scopeKey(scope), {
              createdAt: last.createdAt,
              id: last.id,
            })
          : null,
    };
  }

  /** Unsearchable no later than the response (status and passages change in one transaction); the bytes follow. */
  async remove(scope: DocumentScope, id: string): Promise<void> {
    const removed = await this.documents.remove(scope, id);
    if (!removed) throw notFound('The document');
    await this.dropBytes(removed.storageKey, removed.id);
  }

  // -------------------------------------------------------------- internals

  private cursorKey(): string {
    return this.config.get('knowledge_cursor_key') ?? DEV_KNOWLEDGE_CURSOR_KEY;
  }

  private async require(
    scope: DocumentScope,
    id: string,
  ): Promise<DocumentRecord> {
    const doc = await this.documents.find(scope, id);
    if (!doc) throw notFound('The document');
    return doc;
  }

  /** The answer for a repeat of `uploaded`: current status, no second task; `FAILED` is not a replay. */
  private settled(doc: DocumentRecord): KnowledgeDocument {
    if (doc.status === 'FAILED') throw invalidTransition();
    return toDocumentDto(doc);
  }

  /** A repeat of a create: the first document unchanged; a PDF still waiting for bytes gets a fresh grant for its key. */
  private async replay(
    doc: DocumentRecord,
    hash: string,
    size: number,
  ): Promise<CreateResult & { created: boolean }> {
    const upload =
      doc.status === 'AWAITING_UPLOAD'
        ? await this.grant(doc, hash, size)
        : undefined;
    return {
      document: toDocumentDto(doc),
      deduplicated: true,
      created: false,
      ...(upload ? { upload } : {}),
    };
  }

  private async grant(
    doc: DocumentRecord,
    hash: string,
    size: number,
  ): Promise<KnowledgeUploadGrant> {
    const grant = await this.store.presignUpload(
      doc.storageKey,
      hash,
      size,
      this.config.get('knowledge_upload_ttl_s'),
    );
    return {
      url: grant.url,
      headers: grant.headers,
      expiresAt: grant.expiresAt.toISOString(),
    };
  }

  private async assertProductInShop(productId: string, shopId: string) {
    const found = await this.products.getProducts([productId], { shopId });
    const product = found.get(productId.toLowerCase());
    if (!product) throw notFound('The product');
    if (product.status === 'ARCHIVED') throw productArchived();
  }

  /** After the row exists. A failure is logged by id only: the sweep re-enqueues a document left `QUEUED`. */
  private async publish(documentId: string): Promise<void> {
    try {
      await this.tasks.enqueueIngest(documentId);
    } catch (error) {
      this.logger.warn(
        `ingest task not published for ${documentId}: ${(error as Error).name}`,
      );
    }
  }

  /** Best effort: a failure leaves `bytesRemovedAt` empty and the sweep retries (G24). Never logs the key. */
  private async dropBytes(
    storageKey: string,
    documentId?: string,
  ): Promise<void> {
    try {
      await this.store.delete(storageKey);
      if (documentId) await this.documents.markBytesRemoved(documentId);
    } catch (error) {
      this.logger.warn(
        `stored bytes not removed${documentId ? ` for ${documentId}` : ''}: ${(error as Error).name}`,
      );
    }
  }
}
