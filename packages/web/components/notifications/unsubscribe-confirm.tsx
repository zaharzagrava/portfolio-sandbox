'use client';

import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { postUnsubscribe } from '@/lib/api/notifications';
import { problemFromError } from '@/lib/api/errors';
import { formatWait } from '@/lib/auth/retry-after';
import { CATEGORY_LABELS } from './labels';

export function UnsubscribeInvalid() {
  return (
    <div role="alert" className="space-y-2 text-sm">
      <p>This unsubscribe link is not valid. It may have been copied in part.</p>
      <p className="text-muted-foreground">You can change what we send you in your notification settings after you sign in.</p>
    </div>
  );
}

function failureText(error: unknown): string {
  const problem = problemFromError(error);
  if (problem.status === 429) {
    const wait = formatWait(problem.retryAfterSeconds);
    return wait ? `Too many attempts. Try again in ${wait}.` : 'Too many attempts. Try again later.';
  }
  return 'Something went wrong. Try again.';
}

/** The second step: the page only described the change, the button performs it (the POST is what changes state). */
export function UnsubscribeConfirm({ token, category }: { token: string; category: string }) {
  const label = CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
  const mutation = useMutation({ mutationFn: () => postUnsubscribe(token) });
  const problem = mutation.isError ? problemFromError(mutation.error) : null;

  if (problem?.status === 400) return <UnsubscribeInvalid />;
  if (mutation.isSuccess) {
    return (
      <div role="status" className="space-y-2 text-sm">
        <p>You are unsubscribed from {label.toLowerCase()} emails.</p>
        <p className="text-muted-foreground">Other emails and the other ways we reach you are unchanged.</p>
        <Link href="/account/notifications" className="font-medium underline underline-offset-4">
          Notification settings
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-4 text-sm">
      <p>
        Stop receiving <strong>{label.toLowerCase()}</strong> emails? Notifications in the app and other categories are not affected.
      </p>
      {mutation.isError && <p role="alert">{failureText(mutation.error)}</p>}
      <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Unsubscribing…' : 'Unsubscribe'}
      </Button>
    </div>
  );
}
