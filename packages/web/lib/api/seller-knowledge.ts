'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  knowledgeCreateResponseSchema,
  knowledgeDocumentPageSchema,
  knowledgeDocumentSchema,
  type KnowledgeCreateRequest,
  type KnowledgeDocument,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { listQuery } from '@/lib/seller/wire';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

/** S47 knowledge documents of a shop (`specs/domains/S47-rag-help-center/contracts/knowledge-api.md`). */
export const KNOWLEDGE_PAGE_SIZE = 20;
/** While a document is queued or processing the list refetches this often. */
export const KNOWLEDGE_POLL_MS = 3_000;

const base = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/knowledge`;
const doc = (shopId: string, documentId: string) => `${base(shopId)}/documents/${encodeURIComponent(documentId)}`;

export const isPending = (document: Pick<KnowledgeDocument, 'status'>): boolean => document.status === 'QUEUED' || document.status === 'PROCESSING';

export type KnowledgeParams = { status?: string; cursor?: string };

export function useKnowledgeDocuments(shopId: string, params: KnowledgeParams, pollMs: number = KNOWLEDGE_POLL_MS) {
  return useQuery({
    queryKey: queryKeys.seller.knowledgeDocuments(shopId, params),
    queryFn: async () =>
      parseBody(knowledgeDocumentPageSchema, (await apiClient.get<unknown>(`${base(shopId)}/documents`, { params: listQuery(KNOWLEDGE_PAGE_SIZE, params) })).data),
    placeholderData: keepPreviousData,
    // Polls only while something is being indexed; a failed or finished list is left alone.
    refetchInterval: (query) => (query.state.data?.items.some(isPending) ? pollMs : false),
    retry: retryUnlessClientError,
  });
}

/** The file did not reach storage (the grant expired, the network dropped): the document stays "Waiting for file". */
export class UploadFailedError extends Error {
  constructor() {
    super('upload_failed');
    this.name = 'UploadFailedError';
  }
}

export type DocumentSource = { kind: 'markdown'; markdown: string } | { kind: 'pdf'; file: File };
export type NewDocument = { title: string; visibility: 'PUBLIC' | 'SHOP_PRIVATE'; productId?: string; source: DocumentSource };

/** Lower-case hex SHA-256 of a file, as the create request wants it. */
export async function sha256Hex(file: Blob): Promise<string> {
  const bytes = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Response(file).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function useInvalidateDocuments(shopId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'knowledge') });
}

/**
 * Create: markdown goes inline; a PDF is announced with its hash and size, then the file goes straight to storage with the
 * presigned grant (no cookie, no CSRF header, no token) and `uploaded` tells S47 it arrived. `deduplicated` means the same
 * content already exists in this scope.
 */
export function useCreateDocument(shopId: string) {
  const invalidate = useInvalidateDocuments(shopId);
  return useMutation({
    mutationFn: async (input: NewDocument): Promise<{ document: KnowledgeDocument; deduplicated: boolean }> => {
      const common = { title: input.title, visibility: input.visibility, ...(input.productId ? { productId: input.productId } : {}) };
      const body: KnowledgeCreateRequest =
        input.source.kind === 'markdown'
          ? { ...common, markdown: input.source.markdown }
          : { ...common, pdfSha256: await sha256Hex(input.source.file), pdfSize: input.source.file.size };
      const created = parseBody(knowledgeCreateResponseSchema, (await apiClient.post<unknown>(`${base(shopId)}/documents`, body)).data);
      if (!created.upload || input.source.kind !== 'pdf') return { document: created.document, deduplicated: created.deduplicated };

      let put: Response;
      try {
        put = await fetch(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: input.source.file, credentials: 'omit' });
      } catch {
        throw new UploadFailedError();
      }
      if (!put.ok) throw new UploadFailedError();
      const uploaded = parseBody(knowledgeDocumentSchema, (await apiClient.post<unknown>(`${doc(shopId, created.document.id)}/uploaded`)).data);
      return { document: uploaded, deduplicated: created.deduplicated };
    },
    onSettled: invalidate,
  });
}

/** Only from `FAILED`; the answer is the document queued again. */
export function useRetryDocument(shopId: string) {
  const invalidate = useInvalidateDocuments(shopId);
  return useMutation({
    mutationFn: async (documentId: string) => parseBody(knowledgeDocumentSchema, (await apiClient.post<unknown>(`${doc(shopId, documentId)}/retry`)).data),
    onSettled: invalidate,
  });
}

export function useDeleteDocument(shopId: string) {
  const invalidate = useInvalidateDocuments(shopId);
  return useMutation({
    mutationFn: async (documentId: string): Promise<void> => {
      await apiClient.delete(doc(shopId, documentId));
    },
    onSettled: invalidate,
  });
}

/** The path of the help-center ask stream (`shop.read`; allowed in a suspended shop). */
export const askPath = (shopId: string): string => `${base(shopId)}/ask`;
