import Link from 'next/link';

/** Photos and video of one product: two routes, one pair of links. */
export function MediaTabs({ shopId, productId, current }: { shopId: string; productId: string; current: 'photos' | 'video' }) {
  const base = `/dashboard/seller/${encodeURIComponent(shopId)}/products/${encodeURIComponent(productId)}/media`;
  const link = (label: string, href: string, active: boolean) => (
    <Link href={href} aria-current={active ? 'page' : undefined} className={`min-h-11 rounded-md border px-3 py-2 text-sm sm:min-h-8 sm:py-1 ${active ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}>
      {label}
    </Link>
  );
  return (
    <nav aria-label="Product media" className="flex gap-2">
      {link('Photos', base, current === 'photos')}
      {link('Video', `${base}/video`, current === 'video')}
    </nav>
  );
}
