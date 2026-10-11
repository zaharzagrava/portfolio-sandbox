import { memo } from 'react';
import Link from 'next/link';
import { ImageOff, Star } from 'lucide-react';
import { cn, formatMoney } from '@/lib/utils';
import { safeHttpsUrl } from '@/lib/safe-url';
import { Card } from '@/components/ui/card';
import type { CardModel } from '@/lib/product/cards';

/**
 * The product card of search results and rails (W02 FR-024): one link named by the title and price, so a screen reader
 * announces it once. The image is decorative (empty alt) and only an `https` address is used; otherwise a neutral block
 * of the same size. A server component: no state, no handlers.
 */
function ProductCardView({ card, className }: { card: CardModel; className?: string }) {
  const image = safeHttpsUrl(card.imageUrl);
  return (
    <Card className={cn('group h-full overflow-hidden py-0 transition-shadow hover:shadow-lg motion-reduce:transition-none', className)} data-testid="product-card">
      <Link href={card.href} className="flex h-full flex-col focus-visible:outline-2 focus-visible:outline-ring">
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- hosts are pinned by the CSP `img-src`; dimensions come from the aspect-square box
            <img
              src={image}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
            />
          ) : (
            <div data-testid="card-image-placeholder" aria-hidden="true" className="flex size-full items-center justify-center text-muted-foreground">
              <ImageOff className="size-8" />
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1 p-4">
          {card.sponsored ? <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sponsored</span> : null}
          <h3 className="line-clamp-2 text-base font-medium">{card.title}</h3>
          {card.brand ? <p className="text-sm text-muted-foreground">{card.brand}</p> : null}
          {card.rating && card.rating > 0 ? (
            <p className="flex items-center gap-1 text-sm">
              <Star aria-hidden="true" className="size-4 fill-primary text-primary" />
              <span>{`Rated ${card.rating.toFixed(1)} out of 5`}</span>
            </p>
          ) : null}
          <p className="mt-auto pt-2 text-lg font-semibold">{formatMoney(card.priceMinor, card.currency)}</p>
          {card.inStock === false ? <p className="text-sm font-medium text-destructive">Out of stock</p> : null}
        </div>
      </Link>
    </Card>
  );
}

export const ProductCard = memo(function ProductCard(props: CardModel & { className?: string }) {
  const { className, ...card } = props;
  return <ProductCardView card={card} className={className} />;
});
