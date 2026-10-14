'use client';

import { useEffect, type MouseEvent } from 'react';

export type LegalSection = { id: string; title: string };

/** Moves focus to the heading of `id`; the heading carries `tabIndex={-1}`. */
function focusHeading(id: string) {
  const heading = document.getElementById(id);
  if (!heading) return;
  heading.focus({ preventScroll: true });
}

/**
 * "On this page" (AS-25): a sticky rail at 1024 px and wider, a collapsed disclosure above the text below that. The links
 * are plain anchors, so they work without scripts; this leaf only adds the focus move that a bare fragment does not do.
 */
export function OnThisPage({ sections }: { sections: LegalSection[] }) {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) focusHeading(id);
  }, []);

  function go(event: MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    window.history.pushState(null, '', `#${id}`);
    document.getElementById(id)?.scrollIntoView?.();
    focusHeading(id);
  }

  const links = sections.map((section) => (
    <li key={section.id}>
      <a href={`#${section.id}`} onClick={(event) => go(event, section.id)} className="block min-h-11 py-2 text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
        {section.title}
      </a>
    </li>
  ));

  return (
    <div className="lg:order-last lg:w-56 lg:shrink-0">
      <details className="rounded-md border px-4 lg:hidden">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">On this page</summary>
        <ul className="pb-2">{links}</ul>
      </details>
      <nav aria-label="On this page" className="sticky top-24 hidden self-start lg:block">
        <p className="mb-2 text-sm font-medium">On this page</p>
        <ul>{links}</ul>
      </nav>
    </div>
  );
}
