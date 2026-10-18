import { Suspense } from 'react';
import { requireAdminPage } from '@/components/admin/admin-guard';
import { CreateFlagForm } from '@/components/admin/flags/create-flag-form';
import { Skeleton } from '@/components/ui/skeleton';
import { NEW_FLAG_PATH } from '@/lib/admin/flags/params';

export const metadata = { title: 'New flag · Marketplace Admin' };

async function Form() {
  if (!(await requireAdminPage(NEW_FLAG_PATH))) return null;
  return <CreateFlagForm />;
}

/** A static frame (heading, card) with the guard and the form inside `<Suspense>` (W06 FR-002, AS-09): centred, 40 rem at most. */
export default function NewFlagPage() {
  return (
    <div className="mx-auto w-full max-w-160 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">New flag</h1>
      <div className="rounded-xl border bg-background p-4 sm:p-6">
        <Suspense
          fallback={
            <div aria-hidden="true" data-skeleton="create-form" className="space-y-5">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          }
        >
          <Form />
        </Suspense>
      </div>
    </div>
  );
}
