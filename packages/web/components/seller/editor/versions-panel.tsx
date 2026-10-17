'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Instant } from '@/components/seller/developers/shared';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useCreateVersion, useDraftVersions } from '@/lib/api/seller-listing-drafts';

const KIND_LABEL: Record<string, string> = { named: 'Saved version', published: 'Published' };

/**
 * The saved versions of a draft (S06): newest first, "Load more" for the next page, and "Save version" with a name of 1 to
 * 80 characters without control characters (the server decides; the form only refuses an empty name).
 */
export function VersionsPanel({ shopId, draftId, canWrite, writable }: { shopId: string; draftId: string; canWrite: boolean; writable: boolean }) {
  const nameId = useId();
  const versions = useDraftVersions(shopId, draftId);
  const create = useCreateVersion(shopId, draftId);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function save() {
    setProblem(null);
    if (!name.trim()) return setError('Enter a name for this version.');
    setError(null);
    try {
      await create.mutateAsync(name.trim());
      toast.success('Version saved');
      setName('');
    } catch (caught) {
      setProblem(problemFromError(caught));
    }
  }

  const items = versions.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby={`${nameId}-heading`} className="space-y-3">
      <h2 id={`${nameId}-heading`} className="text-lg font-semibold">
        Versions
      </h2>
      {canWrite && (
        <form
          className="flex flex-wrap items-end gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1">
            <label htmlFor={nameId} className="text-sm font-medium">
              Version name
            </label>
            <Input id={nameId} value={name} maxLength={80} disabled={!writable} aria-invalid={error ? true : undefined} aria-describedby={error ? `${nameId}-error` : undefined} onChange={(event) => setName(event.target.value)} />
          </div>
          <Button type="submit" variant="outline" disabled={!writable || create.isPending}>
            Save version
          </Button>
          {error && (
            <p id={`${nameId}-error`} className="w-full text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}
      {versions.isError && !versions.data ? (
        <SectionError error={versions.error} onRetry={() => void versions.refetch()} />
      ) : !versions.data ? (
        <div role="status" aria-label="Loading versions" className="h-16 animate-pulse rounded-lg bg-muted" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No saved versions yet.</p>
      ) : (
        <>
          <ul aria-label="Saved versions" className="divide-y rounded-lg border text-sm">
            {items.map((version) => (
              <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="font-medium">{version.name}</span>
                <span className="text-muted-foreground">
                  {KIND_LABEL[version.kind] ?? version.kind}, <Instant value={version.createdAt} />
                </span>
              </li>
            ))}
          </ul>
          {versions.hasNextPage && (
            <Button type="button" variant="outline" disabled={versions.isFetchingNextPage} onClick={() => void versions.fetchNextPage()}>
              Load more versions
            </Button>
          )}
        </>
      )}
    </section>
  );
}
