import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  Chunk,
  chunkSections,
  chunkText,
  markdownSections,
  pdfSections,
  Section,
} from '../domain/chunker';
import { IngestFailure } from '../domain/failure-codes';
import {
  ragIngestCounter,
  ragIngestDuration,
} from '../domain/knowledge-metrics';
import {
  DOCUMENT_REPOSITORY,
  EMBEDDING_PROVIDER,
  EmbeddingUnavailableError,
  OBJECT_STORE,
  ObjectTooLargeError,
  PASSAGE_REPOSITORY,
  PDF_PARSER,
} from '../domain/ports';
import type {
  DocumentRecord,
  DocumentRepository,
  EmbeddingProvider,
  ObjectStore,
  PassageRepository,
  PdfParser,
} from '../domain/ports';

export const MAX_PASSAGES_PER_DOCUMENT = 2_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const STORAGE_READ_TIMEOUT_MS = 10_000;
const EMBED_CALL_TIMEOUT_MS = 30_000;

/**
 * The queue handler of `knowledge-ingest` (S47 R-6, FR-004 – FR-006). One retry layer: redelivery.
 *
 *  1. claim: a conditional update with a lease token; nothing claimed means "delivered again, deleted, or someone else
 *     has it" and the task is acknowledged;
 *  2. read, check size and hash, parse, split: a deterministic problem ends `FAILED(code)` and the task is acknowledged;
 *  3. embed in batches, each call with its own deadline and no internal retry;
 *  4. commit in ONE transaction: `READY` (checked against the lease) and the passage swap, so readers see all old or all
 *     new passages; a delete that won the race leaves the document `DELETED` with no passages;
 *  5. a transient problem releases the claim (`QUEUED`) and rethrows so the queue redelivers; at the last receive the
 *     document ends `FAILED(embedding_unavailable)` and the previous passages stay untouched.
 *
 * No network call runs inside a database transaction. Logs carry ids and codes only.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PASSAGE_REPOSITORY) private readonly passages: PassageRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(PDF_PARSER) private readonly pdf: PdfParser,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly config: ApiConfigService,
  ) {}

  async ingest(documentId: string, receiveCount: number): Promise<void> {
    const started = this.clock.nowMs();
    const doc = await this.documents.claim(
      documentId,
      this.config.get('knowledge_processing_lease_ms'),
    );
    if (!doc) {
      ragIngestCounter.add(1, { outcome: 'noop' });
      return;
    }
    const token = doc.leaseToken as string;
    const finish = (outcome: string) => {
      ragIngestCounter.add(1, { outcome });
      ragIngestDuration.record((this.clock.nowMs() - started) / 1000, {
        outcome,
      });
    };
    try {
      const chunks = await this.prepare(doc);
      const embeddings = await this.embedAll(chunks.map(chunkText));
      const committed = await this.commit(doc, token, chunks, embeddings);
      finish(committed ? 'ready' : 'superseded');
    } catch (error) {
      if (error instanceof IngestFailure) {
        await this.documents.fail(doc.id, token, error.code);
        this.logger.warn(`document ${doc.id} failed: ${error.code}`);
        finish('failed');
        return; // deterministic: acknowledged, never redelivered
      }
      const last = receiveCount >= this.config.get('knowledge_max_receives');
      if (last) {
        await this.documents.fail(doc.id, token, 'embedding_unavailable');
        finish('dead_lettered');
      } else {
        await this.documents.release(doc.id, token);
        finish('requeued');
      }
      this.logger.warn(
        `document ${doc.id} ingestion pass ${receiveCount} failed: ${(error as Error).name}`,
      );
      throw error; // transient: the queue redelivers, or dead-letters after the last receive
    }
  }

  /** Bytes → checked → sections → chunks. Every failure here is deterministic. */
  private async prepare(doc: DocumentRecord): Promise<Chunk[]> {
    const bytes = await this.read(doc);
    if (
      (doc.contentSize !== null && bytes.length !== doc.contentSize) ||
      (doc.contentHash !== null &&
        createHash('sha256').update(bytes).digest('hex') !== doc.contentHash)
    )
      throw new IngestFailure('size_mismatch');

    let chunks: Chunk[];
    try {
      const sections = await this.sections(doc, bytes);
      chunks = chunkSections(sections);
    } catch (error) {
      if (error instanceof IngestFailure) throw error;
      throw new IngestFailure('unparseable', (error as Error).message);
    }
    if (!chunks.length) throw new IngestFailure('no_text');
    if (chunks.length > MAX_PASSAGES_PER_DOCUMENT)
      throw new IngestFailure('too_many_chunks');
    return chunks;
  }

  private async read(doc: DocumentRecord): Promise<Buffer> {
    try {
      return await this.store.read(doc.storageKey, {
        maxBytes: doc.format === 'PDF' ? MAX_PDF_BYTES : MAX_MARKDOWN_BYTES,
        timeoutMs: STORAGE_READ_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof ObjectTooLargeError)
        throw new IngestFailure('size_mismatch');
      throw error; // storage trouble is transient
    }
  }

  private async sections(
    doc: DocumentRecord,
    bytes: Buffer,
  ): Promise<Section[]> {
    if (doc.format === 'MARKDOWN')
      return markdownSections(bytes.toString('utf8'), doc.title);
    const pages = await this.pdf.pages(
      bytes,
      this.config.get('knowledge_max_pages'),
    );
    return pdfSections(pages, doc.title);
  }

  /** Batches of `knowledge_embed_batch`, one deadline per call, no retry; a malformed answer is a provider failure. */
  private async embedAll(texts: string[]): Promise<number[][]> {
    const size = this.config.get('knowledge_embed_batch');
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const vectors = await this.embedder.embed(batch, {
        kind: 'document',
        signal: AbortSignal.timeout(EMBED_CALL_TIMEOUT_MS),
      });
      if (
        vectors.length !== batch.length ||
        vectors.some((v) => v.length !== this.embedder.dimensions)
      )
        throw new EmbeddingUnavailableError(
          'embedding answer has the wrong shape',
        );
      out.push(...vectors);
    }
    return out;
  }

  /** One transaction: the lease-checked `READY` update first (it locks the row), then the passage swap. */
  private commit(
    doc: DocumentRecord,
    token: string,
    chunks: Chunk[],
    embeddings: number[][],
  ): Promise<boolean> {
    return this.tx.run(async () => {
      const marked = await this.documents.markReady(doc.id, token, {
        chunkCount: chunks.length,
        indexedHash: doc.contentHash ?? '',
        embeddingModel: this.embedder.model,
      });
      if (!marked) return false; // deleted (or the lease was taken over) while we embedded: write nothing
      await this.passages.replace(
        doc,
        this.embedder.model,
        chunks.map((c, i) => ({
          ordinal: c.ordinal,
          headingPath: c.headingPath,
          page: c.page,
          content: c.content,
          tokens: c.tokens,
          embedding: embeddings[i],
        })),
      );
      return true;
    });
  }
}
