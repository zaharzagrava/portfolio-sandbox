'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/search', label: 'Browse' },
  { href: '/developers/docs', label: 'Developers', section: '/developers' },
] as const;

/** The desktop "Main" navigation; the link of the current section carries `aria-current="page"`. */
export function MainNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="ml-2 hidden items-center gap-1 lg:flex">
      {links.map((link) => {
        const base = 'section' in link ? link.section : link.href;
        const current = pathname === base || pathname.startsWith(`${base}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? 'page' : undefined}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:text-foreground"
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
