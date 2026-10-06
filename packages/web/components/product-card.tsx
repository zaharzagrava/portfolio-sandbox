import Link from 'next/link';
import { Star } from 'lucide-react';
import { cn, formatMoney } from '@/lib/utils';
import { Card, CardContent, CardFooter } from '@/components/ui/card';

export interface ProductCardProps {
  id: string;
  slug: string;
  name: string;
  shopName: string;
  price: number;
  rating: number;
  reviewsCount: number;
  imageUrl?: string;
  className?: string;
}

export function ProductCard({
  id,
  slug,
  name,
  shopName,
  price,
  rating,
  reviewsCount,
  imageUrl = 'https://placehold.co/400x400/png',
  className,
}: ProductCardProps) {
  return (
    <Card className={cn("overflow-hidden hover:shadow-lg transition-shadow group flex flex-col h-full", className)}>
      <Link href={`/products/${slug}`} className="flex-1 flex flex-col">
        <div className="relative aspect-square overflow-hidden bg-muted">
          <img 
            src={imageUrl} 
            alt={name} 
            className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-300" 
          />
        </div>
        <CardContent className="p-4 flex-1">
          <h3 className="font-medium text-base line-clamp-2 mb-1">{name}</h3>
          <p className="text-sm text-muted-foreground mb-2">{shopName}</p>
          <div className="flex items-center gap-1 mt-auto">
            <Star className="w-4 h-4 fill-primary text-primary" />
            <span className="text-sm font-medium">{rating.toFixed(1)}</span>
            <span className="text-xs text-muted-foreground">({reviewsCount})</span>
          </div>
        </CardContent>
        <CardFooter className="p-4 pt-0">
          <div className="font-semibold text-lg">{formatMoney ? formatMoney(price) : `$${(price / 100).toFixed(2)}`}</div>
        </CardFooter>
      </Link>
    </Card>
  );
}
