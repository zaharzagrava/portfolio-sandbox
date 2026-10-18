import Link from 'next/link';
import { Button } from '@/components/ui/button';

/** Shown in place of the whole console for a signed-in member who is not an admin (W06 AS-48). It never includes flag data or navigation. */
export function ForbiddenPanel() {
  return (
    <section className="mx-auto flex max-w-prose flex-col items-start gap-3 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">You don&apos;t have access to this area.</h1>
      <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
        <Link href="/">Back to marketplace</Link>
      </Button>
    </section>
  );
}
