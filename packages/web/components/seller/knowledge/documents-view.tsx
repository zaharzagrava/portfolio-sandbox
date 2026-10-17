'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon } from 'lucide-react';
import type { KnowledgeDocument } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { DialogProblem, Instant, NativeSelect, PageLinks } from '@/components/seller/developers/shared';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { RowMenu } from '@/components/seller/row-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { KNOWLEDGE_POLL_MS, useDeleteDocument, useKnowledgeDocuments, useRetryDocument } from '@/lib/api/seller-knowledge';
import { useInventory } from '@/lib/api/seller-products';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';
import { buildQuery, readCursor } from '@/lib/seller/search-params';
import { AddDocumentDialog } from './add-document-dialog';
import { HelpAsk } from './help-ask';

const STATUSES = ['AWAITING_UPLOAD', 'QUEUED', 'PROCESSING', 'READY', 'FAILED'] as const;
const STATUS_LABEL: Record<string, string> = { AWAITING_UPLOAD: 'Waiting for the file', QUEUED: 'Queued', PROCESSING: 'Processing', READY: 'Ready', FAILED: 'Failed' };
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = { READY: 'default', FAILED: 'destructive', QUEUED: 'secondary', PROCESSING: 'secondary', AWAITING_UPLOAD: 'outline' };
const VISIBILITY_LABEL: Record<string, string> = { PUBLIC: 'Public', SHOP_PRIVATE: 'Private to this shop', PLATFORM: 'Platform' };
const FAILURE_LABEL: Record<string, string> = {
  not_a_pdf: "The file isn't a PDF.",
  unparseable: "We couldn't read the file.",
  no_text: 'The file has no text we can read.',
  too_many_pages: 'The file has too many pages.',
  too_many_chunks: 'The document is too long.',
  size_mismatch: "The uploaded file didn't match the size you gave.",
  embedding_unavailable: "We couldn't index it right now. Try again.",
};
const ACTIVE_PRODUCTS = { q: '', status: 'ACTIVE', inStock: undefined, cursor: undefined } as const;

/**
 * The shop's knowledge documents (W04 US10, S47): the list with status and failure reason (polled while indexing), add
 * (markdown or PDF through a presigned upload), retry, delete, and the help-center question box. Anyone with
 * `products.read` sees the list; changes need `products.write`; asking needs `shop.read`.
 */
export function DocumentsView({ shopId, pollMs = KNOWLEDGE_POLL_MS }: { shopId: string; pollMs?: number }) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/knowledge`;
  const searchParams = useSearchParams();
  const rawStatus = searchParams.get('status');
  const status = STATUSES.find((value) => value === rawStatus);
  const cursor = readCursor(searchParams.get('cursor') ?? undefined);
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canWrite = shopCan(shop, 'products.write');
  const list = useKnowledgeDocuments(shopId, { status, cursor }, pollMs);
  const products = useInventory(shopId, ACTIVE_PRODUCTS).data?.items ?? [];
  const retry = useRetryDocument(shopId);

  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null);
  const [shown, setShown] = useState<Problem | null>(null);

  const hrefFor = (nextStatus: string | undefined, nextCursor?: string) => {
    const query = buildQuery({ status: nextStatus, cursor: nextCursor });
    return query ? `${pathname}?${query}` : pathname;
  };

  async function runRetry(document: KnowledgeDocument) {
    setShown(null);
    try {
      await retry.mutateAsync(document.id);
    } catch (error) {
      const problem = problemFromError(error);
      if (!sellerProblemCopy(problem, { resource: 'document' }).silent) setShown(problem);
    }
  }

  if (!shop) return <TableRowsSkeleton name="documents" />;

  const data = list.data;
  const busy = list.isPlaceholderData;

  const columns: Column<KnowledgeDocument>[] = [
    { id: 'title', header: 'Title', primary: true, cell: (row) => <span className="break-words">{row.title}</span> },
    { id: 'visibility', header: 'Visibility', cell: (row) => VISIBILITY_LABEL[row.visibility] ?? row.visibility },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          <Badge variant={STATUS_VARIANT[row.status] ?? 'outline'}>{STATUS_LABEL[row.status] ?? row.status}</Badge>
          {row.status === 'FAILED' && row.failureCode && <span className="text-xs text-muted-foreground">{FAILURE_LABEL[row.failureCode] ?? 'Indexing failed.'}</span>}
        </span>
      ),
    },
    { id: 'chunks', header: 'Chunks', cell: (row) => row.chunkCount },
    { id: 'updated', header: 'Updated', cell: (row) => <Instant value={row.updatedAt} /> },
  ];

  const menuFor = (row: KnowledgeDocument) => [
    { id: 'retry', label: 'Retry', hidden: !canWrite || row.status !== 'FAILED', disabled: !writable, onSelect: () => void runRetry(row) },
    { id: 'delete', label: 'Delete', hidden: !canWrite, disabled: !writable, destructive: true, onSelect: () => setDeleting(row) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Help documents</h1>
          <p className="text-sm text-muted-foreground">Documents of {shop.name} that the help-center assistant answers from.</p>
        </div>
        {canWrite && (
          <div className="flex flex-col items-end gap-1">
            <Button type="button" className="min-h-11 sm:min-h-8" disabled={!writable} aria-describedby={!writable ? 'docs-add-note' : undefined} onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" />
              Add document
            </Button>
            {!writable && (
              <p id="docs-add-note" className="max-w-xs text-right text-xs text-muted-foreground">
                {reason}
              </p>
            )}
          </div>
        )}
      </div>

      <HelpAsk shopId={shopId} />

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="docs-status" className="text-sm font-medium">
          Status
        </label>
        <NativeSelect id="docs-status" className="w-auto" value={status ?? ''} onChange={(event) => router.push(hrefFor(event.target.value || undefined))}>
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABEL[value]}
            </option>
          ))}
        </NativeSelect>
      </div>

      {shown && <ProblemPanel problem={shown} context={{ place: 'dialog', resource: 'document' }} />}

      <div role="region" aria-label="Documents">
        {list.isError ? (
          <SectionError error={list.error} onRetry={() => void list.refetch()} firstPageHref={pathname} />
        ) : !data ? (
          <TableRowsSkeleton name="documents" />
        ) : data.items.length === 0 && !busy ? (
          <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
            {cursor ? (
              <>
                <p>No documents on this page.</p>
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={hrefFor(status)}>First page</Link>
                </Button>
              </>
            ) : status ? (
              <p>No documents match this status.</p>
            ) : (
              <>
                <p>No documents yet.</p>
                {canWrite && <p className="text-sm text-muted-foreground">Add one so the assistant can answer from it.</p>}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ResponsiveTable
              caption={`Documents of ${shop.name}`}
              captionHidden
              columns={columns}
              rows={data.items}
              rowKey={(row) => row.id}
              busy={busy}
              actions={(row) => <RowMenu label={row.title} items={menuFor(row)} />}
            />
            {!busy && <PageLinks firstHref={cursor ? hrefFor(status) : undefined} nextHref={data.nextCursor ? hrefFor(status, data.nextCursor) : null} />}
          </div>
        )}
      </div>

      <AddDocumentDialog shopId={shopId} open={adding} onOpenChange={setAdding} products={products} />
      <DeleteDialog shopId={shopId} document={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function DeleteDialog({ shopId, document, onClose }: { shopId: string; document: KnowledgeDocument | null; onClose: () => void }) {
  const remove = useDeleteDocument(shopId);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function confirm() {
    if (!document) return;
    setProblem(null);
    try {
      await remove.mutateAsync(document.id);
      toast.success('Document deleted');
      onClose();
    } catch (error) {
      const failed = problemFromError(error);
      const copy = sellerProblemCopy(failed, { place: 'dialog', resource: 'document' });
      if (copy.form === 'toast' || copy.silent) {
        if (copy.message) toast.error(copy.message);
        return onClose();
      }
      setProblem(failed);
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={document !== null}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
      title="Delete this document?"
      description="The assistant stops answering from it. This can't be undone."
      confirmLabel="Delete document"
      destructive
      error={problem ? <DialogProblem problem={problem} resource="document" /> : undefined}
      onConfirm={confirm}
    />
  );
}
