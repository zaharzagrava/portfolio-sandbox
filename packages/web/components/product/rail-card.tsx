import { memo } from 'react';
import Link from 'next/link';
import { cn, formatMoney } from '@/lib/utils';
import { facetLabel } from '@/lib/search/facet-label';
import { Card } from '@/components/ui/card';
import type { CardModel } from '@/lib/product/cards';

/** The text card of the rails (trending, bought together): optional rank badge, title, category and price; no image. */
export const RailCard = memo(function RailCard({ className, ...card }: CardModel & { className?: string }) {
  return (
    <Card className={cn('h-full py-0 transition-shadow hover:shadow-md motion-reduce:transition-none', className)} data-testid="rail-card">
      <Link href={card.href} className="flex h-full flex-col gap-2 p-4 focus-visible:outline-2 focus-visible:outline-ring">
        {card.rank !== undefined ? (
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{card.rank}</span>
        ) : null}
        <h3 className="line-clamp-2 text-base font-medium">{card.title}</h3>
        {card.category ? <p className="text-sm text-muted-foreground">{facetLabel(card.category)}</p> : null}
        <p className="mt-auto pt-2 text-lg font-semibold">{formatMoney(card.priceMinor, card.currency)}</p>
      </Link>
    </Card>
  );
});
