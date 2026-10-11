'use client';

// Stand-in for the W02 contract: the owner replaces the body, never the name or props.

import { usePathname, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';

/** The navbar search box. Renders nothing on `/` and `/search`, where the page has its own box (W02 rule). */
export function SearchBox({ variant }: { variant: 'navbar' }) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState('');

  if (pathname === '/' || pathname === '/search') return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <form role="search" data-variant={variant} onSubmit={submit} className="relative w-full">
      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        name="q"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search products"
        placeholder="Search products…"
        className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </form>
  );
}
