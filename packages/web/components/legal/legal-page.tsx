import type { ReactNode } from 'react';
import { OnThisPage } from '@/components/legal/on-this-page';

export type LegalPageSection = { id: string; title: string; body: ReactNode };

/**
 * The shared body of the two legal pages (AS-25): text column of at most 48 rem, "On this page" on the right from
 * 1024 px and above the text below that. A Server Component; static, no data request.
 */
export function LegalPage({ title, updated, sections }: { title: string; updated: string; sections: LegalPageSection[] }) {
  return (
    <div className="container mx-auto flex flex-col gap-6 px-4 py-10 lg:flex-row lg:items-start lg:gap-12">
      <OnThisPage sections={sections.map(({ id, title: sectionTitle }) => ({ id, title: sectionTitle }))} />
      <article className="min-w-0 max-w-3xl flex-1 prose prose-slate dark:prose-invert">
        <h1>{title}</h1>
        <p>Last updated: {updated}</p>
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={section.id}>
            <h2 id={section.id} tabIndex={-1} className="scroll-mt-24 outline-none">
              {section.title}
            </h2>
            {section.body}
          </section>
        ))}
      </article>
    </div>
  );
}
