import type { DocumentStatus } from './document-state';
import type { FailureCode } from './failure-codes';
import type { DocumentScope, RetrievalScope, Visibility } from './scope';

/**
 * Ports of the knowledge half (S47 research R-1, D-6). `application/` injects these tokens only; `infra/` binds them.
 * Raw SQL, the embedding provider, the object store, the queue, the cache, the catalog and tenancy lookups, the model
 * and the call recorder all sit behind one interface each, so a spec can wrap one adapter with a failure or stall
 * injector without mocking the project's own stores (VII.9).
 */

// ---------------------------------------------------------------- documents

export type DocumentFormat = 'MARKDOWN' | 'PDF';

/** A document row as the repository returns it. `createdAt`/`updatedAt` are the database's microsecond text. */
export interface DocumentRecord {
  id: string;
  shopId: string | null;
  productId: string | null;
  visibility: Visibility;
  title: string;
  format: DocumentFormat;
  storageKey: string;
  contentHash: string | null;
  contentSize: number | null;
  status: DocumentStatus;
  failureCode: FailureCode | null;
  chunkCount: number;
  indexedHash: string | null;
  embeddingModel: string | null;
  leaseToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewDocument {
  id: string;
  scope: DocumentScope;
  productId: string | null;
  visibility: Visibility;
  title: string;
  format: DocumentFormat;
  storageKey: string;
  contentHash: string;
  contentSize: number;
  status: 'QUEUED' | 'AWAITING_UPLOAD';
  createdBy: string;
}

export type InsertResult =
  | { kind: 'created'; document: DocumentRecord }
  | { kind: 'existing'; document: DocumentRecord }
  | { kind: 'cap_reached' };

export interface DocumentListQuery {
  status?: Exclude<DocumentStatus, 'DELETED'>;
  limit: number;
  after?: { createdAt: string; id: string };
}

export interface ByteRemoval {
  id: string;
  storageKey: string;
}

/**
 * Every state change is `UPDATE … WHERE status = :from [AND leaseToken = :t] RETURNING …` with the scope predicate; a
 * `null` result means "the document was not in the expected state" and the caller re-reads to tell 404 from 409.
 */
export interface DocumentRepository {
  /** Fast path of the idempotent create: the live document with these bytes in this scope. */
  findByHash(
    scope: DocumentScope,
    productId: string | null,
    visibility: Visibility,
    contentHash: string,
  ): Promise<DocumentRecord | null>;
  /** `INSERT … ON CONFLICT DO NOTHING RETURNING`, with the per-shop cap inside the statement (`cap` null = platform). */
  insert(document: NewDocument, cap: number | null): Promise<InsertResult>;
  /** A live (not DELETED) document of this scope, else `null`. */
  find(scope: DocumentScope, id: string): Promise<DocumentRecord | null>;
  /** `from → QUEUED` in scope (`uploaded`, `retry`); clears `failureCode`, sets `queuedAt`. */
  queue(
    scope: DocumentScope,
    id: string,
    from: 'AWAITING_UPLOAD' | 'FAILED',
  ): Promise<DocumentRecord | null>;
  list(
    scope: DocumentScope,
    query: DocumentListQuery,
  ): Promise<{ items: DocumentRecord[]; hasMore: boolean }>;
  /** One conditional update plus the removal of the passages, atomically; `null` when already deleted or not in scope. */
  remove(scope: DocumentScope, id: string): Promise<ByteRemoval | null>;

  // --- ingestion (lease)
  /** `QUEUED` (or `PROCESSING` with an expired lease) → `PROCESSING` with a fresh lease token. */
  claim(id: string, leaseMs: number): Promise<DocumentRecord | null>;
  /** `PROCESSING` (this lease) → `FAILED(code)`. */
  fail(id: string, leaseToken: string, code: FailureCode): Promise<boolean>;
  /** `PROCESSING` (this lease) → `QUEUED` after a transient error; previous passages stay. */
  release(id: string, leaseToken: string): Promise<boolean>;
  /** The READY update of the commit transaction; `false` when the lease or the state is gone (the delete won). */
  markReady(
    id: string,
    leaseToken: string,
    indexed: {
      chunkCount: number;
      indexedHash: string;
      embeddingModel: string;
    },
  ): Promise<boolean>;

  // --- sweep, re-index, lifecycle
  /** `AWAITING_UPLOAD` older than `olderThanMs` → `DELETED`, bytes pending. */
  expireAbandonedUploads(
    olderThanMs: number,
    limit: number,
  ): Promise<ByteRemoval[]>;
  /** `QUEUED` since more than `olderThanMs` → touches `queuedAt` and returns the ids to enqueue again. */
  requeueStale(olderThanMs: number, limit: number): Promise<string[]>;
  /** `PROCESSING` with an expired lease → `QUEUED`; returns the ids to enqueue. */
  releaseExpiredLeases(limit: number): Promise<string[]>;
  /** `DELETED` rows whose bytes are still stored. */
  pendingByteRemovals(limit: number): Promise<ByteRemoval[]>;
  markBytesRemoved(id: string): Promise<void>;
  /** Tombstones older than `olderThanDays`. Returns the number purged. */
  purgeTombstones(olderThanDays: number, limit: number): Promise<number>;
  /** `READY` with a model other than `model` → `QUEUED`; returns the ids to enqueue. */
  queueStaleModel(model: string, limit: number): Promise<string[]>;
  /** A batch of documents of a product / shop → `DELETED` with their passages removed; empty when none are left. */
  purgeBatch(
    by: { productId: string } | { shopId: string },
    limit: number,
  ): Promise<ByteRemoval[]>;
  countByStatus(): Promise<Record<string, number>>;
}

// ----------------------------------------------------------------- passages

export interface NewPassage {
  ordinal: number;
  headingPath: string;
  page: number | null;
  content: string;
  tokens: number;
  embedding: number[];
}

export interface CandidateQuery {
  scope: RetrievalScope;
  queryText: string;
  /** Question embedding; `null` = keyword-only. */
  vector: number[] | null;
  model: string;
  limit: number;
  /** Statement deadline; exceeding it raises `RetrievalUnavailableError`. */
  timeoutMs: number;
}

export interface Candidates {
  vec: { id: string; similarity: number }[];
  fts: { id: string }[];
}

export interface PassageText {
  id: string;
  documentId: string;
  title: string;
  headingPath: string;
  page: number | null;
  content: string;
}

export interface PassageRepository {
  /**
   * Both ranked lists in one statement (scope, document status and, for the meaning list, the model are inside it),
   * then the text of the ids `choose` picks from them with the scope predicate repeated. Both steps read ONE snapshot
   * (a repeatable-read transaction), so a document whose passages are swapped meanwhile shows all old or all new
   * passages to this question, never none and never a mix (S47 AS-41). Throws `RetrievalUnavailableError` on deadline.
   */
  retrieve(
    query: CandidateQuery,
    choose: (candidates: Candidates) => string[],
  ): Promise<{ candidates: Candidates; passages: PassageText[] }>;
  /** Replaces all passages of a document (call inside the commit transaction, after `markReady`). */
  replace(
    document: Pick<
      DocumentRecord,
      'id' | 'shopId' | 'productId' | 'visibility'
    >,
    embeddingModel: string,
    passages: NewPassage[],
  ): Promise<void>;
}

// --------------------------------------------------------- outbound services

export interface EmbedOptions {
  kind: 'document' | 'query';
  signal?: AbortSignal;
}

/** The embedding provider. No internal retry (one retry layer, IV.6); errors are `EmbeddingUnavailableError`. */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** True for the deterministic test embedder (refused in production). */
  readonly testOnly: boolean;
  embed(texts: string[], options: EmbedOptions): Promise<number[][]>;
}

/** Transient provider failure: redelivery retries it (documents) or the question degrades to keywords. */
export class EmbeddingUnavailableError extends Error {
  constructor(message = 'embedding provider unavailable') {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

export interface UploadGrant {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  /** Whole object, bounded by `maxBytes` and `timeoutMs`; larger objects reject with `ObjectTooLargeError`. */
  read(
    key: string,
    options: { maxBytes: number; timeoutMs: number },
  ): Promise<Buffer>;
  delete(key: string): Promise<void>;
  presignUpload(
    key: string,
    sha256Hex: string,
    size: number,
    ttlSeconds: number,
  ): Promise<UploadGrant>;
}

export class ObjectTooLargeError extends Error {
  constructor() {
    super('object too large');
    this.name = 'ObjectTooLargeError';
  }
}

/** PDF text per page. Throws `IngestFailure` (`not_a_pdf`, `unparseable`, `too_many_pages`); never a parser message. */
export interface PdfParser {
  pages(bytes: Buffer, maxPages: number): Promise<string[]>;
}

export interface TaskPublisher {
  enqueueIngest(documentId: string): Promise<void>;
}

/** Optional cache of question embeddings; every failure is swallowed and counted by the adapter. */
export interface QuestionCache {
  get(key: string): Promise<number[] | null>;
  set(key: string, vector: number[], ttlSeconds: number): Promise<void>;
}

export interface ProductFacts {
  id: string;
  shopId: string;
  status: 'ACTIVE' | 'ARCHIVED';
}
export interface ProductDirectory {
  getProducts(
    ids: string[],
    options?: { shopId?: string },
  ): Promise<Map<string, ProductFacts>>;
}

export interface ShopFacts {
  id: string;
  status: string;
}
export interface ShopDirectory {
  getShops(ids: string[]): Promise<Map<string, ShopFacts>>;
}

// ------------------------------------------------------------------- answers

export interface AnswerPassage {
  /** Printable title of the result block (document, heading path, page). */
  title: string;
  /** Stable id of the passage (`chunk:<id>`). */
  source: string;
  text: string;
}

export interface AnswerRequest {
  model: string;
  /** The fixed instruction block; never contains a document or a question. */
  instructions: string;
  passages: AnswerPassage[];
  question: string;
  maxTokens: number;
}

export interface AnswerBlock {
  text: string;
  /** What the provider's structured citation data says supports this block. */
  citations: { kind: 'result' | 'other'; index: number }[];
}

export interface AnswerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AnswerResult {
  blocks: AnswerBlock[];
  refused: boolean;
  refusalCategory: string | null;
  model: string;
  usage: AnswerUsage;
  stopReason: string;
}

/** The model call; abort, unavailability and rejection surface as the three errors below. */
export interface AnswerModel {
  /** True when the scripted provider is bound (refused in production). */
  readonly scripted: boolean;
  stream(
    request: AnswerRequest,
    options: { signal: AbortSignal; onText: (delta: string) => void },
  ): Promise<AnswerResult>;
}

export class AnswerAbortedError extends Error {
  constructor() {
    super('answer aborted');
    this.name = 'AnswerAbortedError';
  }
}
export class AnswerUnavailableError extends Error {
  constructor() {
    super('answer provider unavailable');
    this.name = 'AnswerUnavailableError';
  }
}

export type CallOutcome = 'completed' | 'failed' | 'refused' | 'aborted';

export interface CallRecord {
  callId: string;
  /** User id, or `anonymous`. */
  subjectId: string;
  /** Product id (buyer ask) or shop id (help center). */
  scopeId: string;
  outcome: CallOutcome;
  requestedModel: string;
  model: string | null;
  usage: AnswerUsage;
  /** True when the provider gave no counts and `usage` is an estimate (`chars / 4`). */
  usageEstimated: boolean;
  ttftMs: number | null;
  durationMs: number;
  stopReason: string;
}

/** Records every attempted model call as `llm.call_completed` (purpose `rag`, metric `llm.rag.tokens`). */
export interface CallRecorder {
  record(call: CallRecord): Promise<void>;
}

export type ModerationVerdict =
  { flagged: false } | { flagged: true; category: string };

export const MODERATION_CATEGORIES = [
  'harassment',
  'hate',
  'sexual',
  'violence',
  'self_harm',
  'illegal',
  'sensitive_data',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export interface Moderator {
  /** Rejects (any error, abort) are treated as "moderation unavailable" by the caller (fail closed). */
  moderateInput(
    text: string,
    options: { signal: AbortSignal },
  ): Promise<ModerationVerdict>;
  moderateOutput(
    text: string,
    context: string,
    options: { signal: AbortSignal },
  ): Promise<ModerationVerdict>;
}

// ------------------------------------------------------------------- tokens

export const DOCUMENT_REPOSITORY = Symbol('S47_DOCUMENT_REPOSITORY');
export const PASSAGE_REPOSITORY = Symbol('S47_PASSAGE_REPOSITORY');
export const EMBEDDING_PROVIDER = Symbol('S47_EMBEDDING_PROVIDER');
export const OBJECT_STORE = Symbol('S47_OBJECT_STORE');
export const PDF_PARSER = Symbol('S47_PDF_PARSER');
export const TASK_PUBLISHER = Symbol('S47_TASK_PUBLISHER');
export const QUESTION_CACHE = Symbol('S47_QUESTION_CACHE');
export const PRODUCT_DIRECTORY = Symbol('S47_PRODUCT_DIRECTORY');
export const SHOP_DIRECTORY = Symbol('S47_SHOP_DIRECTORY');
export const ANSWER_MODEL = Symbol('S47_ANSWER_MODEL');
export const CALL_RECORDER = Symbol('S47_CALL_RECORDER');
export const MODERATOR = Symbol('S47_MODERATOR');
