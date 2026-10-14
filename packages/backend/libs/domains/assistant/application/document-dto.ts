import type { KnowledgeDocument } from '@marketplace-sandbox/contracts';
import type { DocumentRecord } from '../domain/ports';

/**
 * The explicit response shape of a document (S47 FR-008, G1): the storage location, content hash, indexed hash,
 * embedding model, creator and lease never leave the domain.
 */
export const toDocumentDto = (r: DocumentRecord): KnowledgeDocument => ({
  id: r.id,
  title: r.title,
  visibility: r.visibility,
  productId: r.productId,
  format: r.format,
  status: r.status,
  failureCode: r.failureCode,
  chunkCount: r.chunkCount,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
