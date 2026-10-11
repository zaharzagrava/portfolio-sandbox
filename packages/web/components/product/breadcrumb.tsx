import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { searchHref } from '@/lib/routes';

/** "Home › {category} › {title}" (W02 FR-060): the last item is the current page and not a link. */
export function Breadcrumb({ category, title }: { category: string; title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6 text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-x-1">
        <li>
          <Link href="/" className="hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Home
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-4" />
        </li>
        <li>
          <Link href={searchHref({ category })} className="hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            {category}
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-4" />
        </li>
        <li className="min-w-0 truncate text-foreground" aria-current="page">
          {title}
        </li>
      </ol>
    </nav>
  );
}
