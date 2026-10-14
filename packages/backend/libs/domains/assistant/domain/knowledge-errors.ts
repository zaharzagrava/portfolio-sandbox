import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of the knowledge half (specs/domains/S47-rag-help-center/contracts/knowledge-api.md). Every one is
 * an `AppError` with a stable problem `code`; none carries document text, a question, a storage path or a provider
 * message in its detail (FR-040). Codes owned by the platform or by other capabilities (`not_found`,
 * `validation_failed`, `invalid_cursor`, `invalid_transition`, `product_archived`, `rate_limited`, ...) are raised here
 * with their usual shape and not registered again.
 */
type Params = ConstructorParameters<typeof AppError>[0];

export const KNOWLEDGE_ERROR_CODES = [
  'invalid_cursor',
  'invalid_transition',
  'product_archived',
  'upload_missing',
  'product_document_must_be_public',
  'document_limit_reached',
  'input_rejected',
  'assistant_busy',
  'assistant_unavailable',
] as const;
export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number];

interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<KnowledgeErrorCode, Definition> = {
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
  },
  invalid_transition: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The document is not in a state that allows this change.',
  },
  product_archived: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The product is archived; restore it first.',
  },
  upload_missing: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The file has not been uploaded yet.',
  },
  product_document_must_be_public: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'A document attached to a product must be public.',
  },
  document_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'This shop has reached its limit of documents; delete one first.',
  },
  input_rejected: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The question cannot be answered.',
  },
  assistant_busy: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Too Many Requests',
    detail: 'The assistant is busy, try again shortly.',
  },
  assistant_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The assistant is temporarily unavailable. Retry shortly.',
  },
};

export const RETRY_AFTER_SECONDS = 2;

export class KnowledgeError extends AppError {
  constructor(
    readonly knowledgeCode: KnowledgeErrorCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[knowledgeCode];
    super({
      status: d.status,
      code: knowledgeCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

export const invalidCursor = () => new KnowledgeError('invalid_cursor');
export const invalidTransition = () => new KnowledgeError('invalid_transition');
export const productArchived = () => new KnowledgeError('product_archived');
export const uploadMissing = () => new KnowledgeError('upload_missing');
export const productDocumentMustBePublic = () =>
  new KnowledgeError('product_document_must_be_public');
export const documentLimitReached = () =>
  new KnowledgeError('document_limit_reached');
/** `category` is the closed moderation category; the question text is never echoed. */
export const inputRejected = (category: string) =>
  new KnowledgeError('input_rejected', { extensions: { category } });
export const assistantBusy = (retryAfterSeconds = RETRY_AFTER_SECONDS) =>
  new KnowledgeError('assistant_busy', { retryAfterSeconds });
export const assistantUnavailable = (retryAfterSeconds = RETRY_AFTER_SECONDS) =>
  new KnowledgeError('assistant_unavailable', { retryAfterSeconds });

/** Identical body for an unknown id, another scope's id and a deleted document (no existence leak, V.4). */
export const notFound = (what = 'The resource') =>
  new AppError({
    status: HttpStatus.NOT_FOUND,
    code: 'not_found',
    title: 'Not Found',
    detail: `${what} was not found.`,
    area: ErrorArea.DOMAIN,
  });

/** A credential was presented and does not verify: the identity capability's `401 invalid_token` shape. */
export const invalidToken = () =>
  new AppError({
    status: HttpStatus.UNAUTHORIZED,
    code: 'invalid_token',
    title: 'Unauthorized',
    detail: 'The request could not be authenticated.',
    area: ErrorArea.DOMAIN,
    headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  });

/** Field-level validation failure: platform `validation_failed` with the offending fields (never their values). */
export const validationFailed = (fields: string[]) =>
  new AppError({
    status: HttpStatus.BAD_REQUEST,
    code: 'validation_failed',
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: {
      errors: fields.map((field) => ({ field, code: 'invalid' })),
    },
  });

/** The retrieval statement exceeded its deadline or the store refused it: mapped to `503 assistant_unavailable`. */
export class RetrievalUnavailableError extends Error {
  constructor() {
    super('retrieval unavailable');
    this.name = 'RetrievalUnavailableError';
  }
}

/** Codes this domain owns, registered at module definition (S54 problem catalog); shared names stay with their owners. */
const NOT_OWNED: KnowledgeErrorCode[] = [
  'invalid_cursor',
  'invalid_transition',
  'product_archived',
  'assistant_busy', // S46 raises the same code with its own wording
];

export const KNOWLEDGE_PROBLEMS: ProblemCatalogEntry[] =
  KNOWLEDGE_ERROR_CODES.filter((code) => !NOT_OWNED.includes(code)).map(
    (code) => ({
      code,
      status: DEFINITIONS[code].status,
      title: DEFINITIONS[code].title,
      detail: DEFINITIONS[code].detail,
      owner: 'assistant',
    }),
  );
