import Link from 'next/link';
import { categoryShortcuts } from '@/lib/home/category-shortcuts';

/** Fixed-height placeholder for the shortcut row, so the hero does not shift when the links arrive. */
export function CategoryRowSkeleton() {
  return <div className="h-11" aria-hidden="true" />;
}

/** The first eight categories as links; the whole row is omitted when the facets cannot be read. */
export async function CategoryRow() {
  const shortcuts = await categoryShortcuts();
  if (shortcuts.length === 0) return <CategoryRowSkeleton />;
  return (
    <nav aria-label="Categories" className="mx-auto mt-6 max-w-3xl">
      <ul className="flex gap-2 overflow-x-auto pb-2 lg:flex-wrap lg:justify-center lg:overflow-visible">
        {shortcuts.map((shortcut) => (
          <li key={shortcut.key} className="shrink-0">
            <Link
              href={shortcut.href}
              className="inline-flex min-h-11 items-center rounded-full border bg-background px-4 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              {shortcut.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
