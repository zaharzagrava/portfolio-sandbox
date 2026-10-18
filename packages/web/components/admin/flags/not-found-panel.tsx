import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LIST_PATH } from '@/lib/admin/flags/params';

/** An unknown flag as a panel (W06 AS-31): the same words as the not-found page, for a flag that disappears while the page is open. */
export function NotFoundPanel() {
  return (
    <section className="flex max-w-prose flex-col items-start gap-3 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">We couldn&apos;t find that flag.</h1>
      <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
        <Link href={LIST_PATH}>All flags</Link>
      </Button>
    </section>
  );
}
