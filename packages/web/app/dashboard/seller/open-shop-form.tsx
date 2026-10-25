'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProblemPanel, RateLimitNotice } from '@/components/seller/problem-states';
import { useRefreshSession } from '@/hooks/use-auth-actions';
import { SHOP_SLUG, slugify } from '@/lib/api/shops';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useOpenShop } from '@/lib/api/seller';
import type { SessionResult } from '@/lib/api/session';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';

/** Delays between the background session refreshes after a shop opens: 1 s, 2 s, 4 s, then stop (W04 AS-04). */
export const ROLE_REFRESH_DELAYS_MS = [1000, 2000, 4000] as const;

const HANDLE_RULE = 'Use 3 to 40 lowercase letters, digits or dashes.';
const NAME_RULE = 'Enter a shop name of 2 to 80 characters.';

type Field = 'name' | 'slug';
type Fields = Partial<Record<Field, string>>;

/**
 * Asks W01 to re-issue the session until it shows the SELLER role. Nothing depends on the answer and nothing is shown:
 * seller pages work from shop membership (W04 AS-04). Runs on after the form unmounts.
 */
async function refreshUntilSeller(refresh: () => Promise<unknown>): Promise<void> {
  for (const delay of ROLE_REFRESH_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const result = (await refresh()) as SessionResult | undefined;
      // The answer is `{ user: { role } }`; any role above a plain buyer's means the claim has caught up.
      if (result?.ok && result.kind === 'session' && result.session.user.role !== 'USER') return;
    } catch {
      /* a failed refresh is simply asked again by the next step */
    }
  }
}

function fieldProblems(problem: Problem): Fields | null {
  const copy = sellerProblemCopy(problem, { kind: 'write' });
  if (copy.form !== 'field') return null;
  if (problem.code !== 'validation_failed') return copy.field === 'slug' || copy.field === 'name' ? { [copy.field]: copy.message } : null;
  const found: Fields = {};
  for (const entry of problem.errors) {
    if (entry.field === 'name') found.name ??= NAME_RULE;
    if (entry.field === 'slug' || entry.field === 'handle') found.slug ??= HANDLE_RULE;
  }
  return Object.keys(found).length > 0 ? found : { name: NAME_RULE };
}

/** The open-shop form of `/dashboard/seller` for a member without a shop (W04 AS-01..AS-07, FR-014, FR-015). */
export function OpenShopForm() {
  const router = useRouter();
  const open = useOpenShop();
  const refreshSession = useRefreshSession();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ name: boolean; slug: boolean }>({ name: false, slug: false });
  const [serverFields, setServerFields] = useState<Fields>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const sending = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);

  const handle = slug ?? slugify(name);
  const nameProblem = serverFields.name ?? (checked.name && name.trim().length < 2 ? NAME_RULE : undefined);
  const handleProblem = serverFields.slug ?? (checked.slug && !SHOP_SLUG.test(handle) ? HANDLE_RULE : undefined);

  useEffect(() => {
    if (focusRequest === 0) return;
    (serverFields.name ? nameRef : slugRef).current?.focus();
    // Only a new server answer moves focus, not later edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const clearServer = (field: Field) => setServerFields((current) => (current[field] ? { ...current, [field]: undefined } : current));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (sending.current || waiting) return;
    const nameOk = name.trim().length >= 2;
    const slugOk = SHOP_SLUG.test(handle);
    setChecked({ name: true, slug: true });
    if (!nameOk || !slugOk) {
      (nameOk ? slugRef : nameRef).current?.focus();
      return;
    }
    sending.current = true;
    setProblem(null);
    setServerFields({});
    open.mutate(
      { name: name.trim(), slug: handle },
      {
        onSuccess: (shop) => {
          toast.success('Your shop is open');
          router.replace(`/dashboard/seller/${shop.id}`); // replace: Back must not return to the form (B-101)
          void refreshUntilSeller(() => refreshSession.mutateAsync());
        },
        onError: (error) => {
          sending.current = false;
          const failed = problemFromError(error);
          const fields = fieldProblems(failed);
          if (fields) {
            setServerFields(fields);
            setFocusRequest((n) => n + 1);
          } else {
            setProblem(failed);
          }
        },
      },
    );
  };

  const copy = problem ? sellerProblemCopy(problem, { kind: 'write', subject: 'attempts' }) : null;
  const busy = open.isPending || open.isSuccess;

  return (
    <Card className="max-w-lg">
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-bold tracking-tight">Open your shop</h1>
          </CardTitle>
          <CardDescription>Start selling on the marketplace. You become the shop&apos;s owner.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="shop-name">Shop name</Label>
            <Input
              ref={nameRef}
              id="shop-name"
              name="name"
              value={name}
              maxLength={80}
              autoComplete="off"
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={nameProblem ? 'shop-name-problem' : undefined}
              onChange={(e) => {
                setName(e.target.value);
                clearServer('name');
                setChecked((c) => ({ ...c, name: false }));
              }}
              onBlur={() => setChecked((c) => ({ ...c, name: true }))}
            />
            {/* The line keeps its height when empty, so an error that appears on blur never pushes "Open shop" away from a click that is under way. */}
            <p id={nameProblem ? 'shop-name-problem' : undefined} className="min-h-8 text-xs text-destructive sm:min-h-4">
              {nameProblem}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="shop-slug">Handle</Label>
            <Input
              ref={slugRef}
              id="shop-slug"
              name="slug"
              value={handle}
              placeholder="my-shop"
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={handleProblem ? true : undefined}
              aria-describedby={handleProblem ? 'shop-slug-problem' : undefined}
              onChange={(e) => {
                setSlug(e.target.value);
                clearServer('slug');
                setChecked((c) => ({ ...c, slug: false }));
              }}
              onBlur={() => setChecked((c) => ({ ...c, slug: true }))}
            />
            <p id={handleProblem ? 'shop-slug-problem' : undefined} className="min-h-8 text-xs text-destructive sm:min-h-4">
              {handleProblem}
            </p>
          </div>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          {problem &&
            (copy?.form === 'countdown' ? (
              <RateLimitNotice seconds={copy.retryAfterSeconds} subject="attempts" token={problem} onActiveChange={setWaiting} />
            ) : (
              <ProblemPanel problem={problem} context={{ kind: 'write', subject: 'attempts' }} />
            ))}
          <Button type="submit" disabled={busy || waiting} className="self-start">
            {open.isPending ? 'Opening…' : 'Open shop'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
