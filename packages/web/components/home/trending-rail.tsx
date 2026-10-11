import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductCard } from '@/components/product/product-card';
import { RailCard } from '@/components/product/rail-card';
import { homeRailSource } from '@/lib/home/rail-source';
import { searchHref } from '@/lib/routes';

const SKELETON_CARDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] as const;
const GRID ='grid grid-cols-2 gap-4 lg:grid-cols-4';

/** The rail's loading state: eight cards of the final size, so nothing shifts when the products arrive. */
export function TrendingRailSkeleton() {
  return (
    <div className={GRID} aria-busy="true" data-testid="home-products-skeleton">
      {SKELETON_CARDS.map((name) => (
        <Skeleton key={name} className="h-32 w-full rounded-xl lg:h-36" />
      ))}
    </div>
  );
}

/** The cards: trending in rank order, else the catalogue's first products, else "No products yet." (W02 FR-003). */
export async function TrendingRailCards() {
  const rail = await homeRailSource();
  if (rail.kind === 'empty') {
    return (
      <p className="text-muted-foreground" data-testid="home-no-products">
        No products yet.
      </p>
    );
  }
  return (
    <ul className={GRID} data-testid="home-products">
      {rail.cards.map((card) => (
        <li key={card.id}>{rail.kind === 'trending' ? <RailCard {...card} /> : <ProductCard {...card} />}</li>
      ))}
    </ul>
  );
}

/** The heading and "View all" link of the rail; the cards stream in under it. */
export function TrendingRailHeader() {
  return (
    <div className="mb-8 flex items-center justify-between gap-4">
      <h2 id="trending-heading" className="text-2xl font-heading font-bold tracking-tight">Trending now</h2>
      <Button variant="ghost" size="sm" asChild>
        <Link href={searchHref()}>
          View all
          <ArrowRight aria-hidden="true" className="ml-1 size-3" />
        </Link>
      </Button>
    </div>
  );
}
