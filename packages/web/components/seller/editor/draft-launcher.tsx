'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useCreateDraft, useOpenDrafts } from '@/lib/api/seller-listing-drafts';
import { useProduct } from '@/lib/api/seller-products';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { ListingEditor } from './listing-editor';

/**
 * The draft page of a product (W04 F1, S06): opens the product's open draft, or offers "Start a draft", which creates one
 * from the product (the server copies the product into the document). The list route has no product filter, so the draft
 * is picked from the shop's open drafts by `productId`.
 */
export function DraftLauncher({ shopId, productId }: { shopId: string; productId: string }) {
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canWrite = shopCan(shop, 'products.write');
  const drafts = useOpenDrafts(shopId);
  const product = useProduct(shopId, productId);
  const create = useCreateDraft(shopId);
  const [problem, setProblem] = useState<Problem | null>(null);
  const inventory = `/dashboard/seller/${encodeURIComponent(shopId)}/inventory`;

  if (drafts.isError && !drafts.data) return <SectionError error={drafts.error} onRetry={() => void drafts.refetch()} />;
  if (!drafts.data) return <div role="status" aria-label="Loading draft" className="h-48 animate-pulse rounded-lg bg-muted" />;

  const found = create.data ?? drafts.data.items.find((item) => item.productId === productId && item.status === 'DRAFT');
  if (found) return <ListingEditor shopId={shopId} draft={found} currency={product.data?.currency} />;

  async function start() {
    setProblem(null);
    try {
      await create.mutateAsync({ title: (product.data?.title ?? 'Untitled draft').slice(0, 120), productId });
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link href={inventory} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Back to inventory
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Edit listing</h1>
      </div>
      {canWrite ? (
        <>
          <p className="text-sm text-muted-foreground">Start a draft to edit this product together with your team. Nothing changes in the shop until you publish.</p>
          {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}
          <Button type="button" disabled={!writable || create.isPending} title={reason ?? undefined} onClick={() => void start()}>
            Start a draft
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">There is no open draft for this product, and your role cannot start one.</p>
      )}
    </div>
  );
}
