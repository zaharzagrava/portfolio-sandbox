'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { FLAG_KEY_PATTERN, FLAG_LIMITS } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useSaveFlag } from '@/hooks/use-admin-flags';
import { useAuth } from '@/hooks/use-auth';
import { flagProblemCopy, type FlagProblemView } from '@/lib/admin/flags/copy';
import { flagHref, LIST_PATH } from '@/lib/admin/flags/params';
import { starterDraft } from '@/lib/admin/flags/starter';
import { toFlagInput } from '@/lib/admin/flags/to-flag-input';
import { readFlagProblem, type FlagProblem } from '@/lib/api/admin-flags';
import { FlagProblemAlert } from './flag-problem';

const FIELD_IDS = ['flag-key', 'flag-description', 'flag-owner'] as const;
type FieldId = (typeof FIELD_IDS)[number];
const errorId = (id: string) => `${id}-error`;

/**
 * The create page's form (W06 AS-09..AS-16): Key, Description (optional) and Owner (the viewer's e-mail), and the starter
 * definition of `lib/admin/flags/starter.ts`: disabled, default and off variant `off`. One `PUT` with `expectedVersion: 0`;
 * a double press sends one request; the key's 409s are explained under the key; semantic problems list at their fields.
 */
export function CreateFlagForm() {
  const router = useRouter();
  const { user } = useAuth();
  const [key, setKey] = useState('');
  const [typedOwner, setOwner] = useState('');
  const [ownerTouched, setOwnerTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [local, setLocal] = useState<Partial<Record<FieldId, string>>>({});
  const [problem, setProblem] = useState<FlagProblem | null>(null);
  const [countdownActive, setCountdownActive] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const save = useSaveFlag(key);
  const sending = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const pending = save.isPending;

  // The owner starts as the viewer's e-mail (AS-10) as soon as the session is known, unless the admin typed one.
  const owner = ownerTouched ? typedOwner : (user?.email ?? '');

  const view: FlagProblemView | null = problem ? flagProblemCopy(problem, { op: 'create', key }) : null;
  const issues = view?.issues ?? [];
  const messageFor = (id: FieldId): string | undefined => {
    if (local[id]) return local[id];
    if (view?.form === 'field' && id === 'flag-key') return view.message;
    return issues.find((issue) => issue.fieldId === id)?.message;
  };

  // Focus moves to the first problem: the first field that has a message, else the summary or the alert.
  useEffect(() => {
    if (attempt === 0) return;
    const first = FIELD_IDS.find((id) => document.getElementById(errorId(id)));
    if (first) document.getElementById(first)?.focus();
    else summary.current?.querySelector<HTMLElement>('[role="alert"]')?.focus();
  }, [attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || countdownActive) return;
    const missing: Partial<Record<FieldId, string>> = {};
    if (key.trim() === '') missing['flag-key'] = 'Enter a key.';
    if (owner.trim() === '') missing['flag-owner'] = 'Enter an owner.';
    setLocal(missing);
    setProblem(null);
    if (Object.keys(missing).length > 0) {
      setAttempt((n) => n + 1);
      return;
    }
    const { input } = toFlagInput(starterDraft({ key: key.trim(), owner: owner.trim(), description }));
    if (!input) return;
    sending.current = true;
    try {
      await save.mutateAsync(input);
      toast(`Flag ${key.trim()} created. It is disabled.`);
      router.push(flagHref(key.trim()));
    } catch (error) {
      setProblem(readFlagProblem(error));
      setAttempt((n) => n + 1);
    } finally {
      sending.current = false;
    }
  }

  const describe = (id: FieldId, hint?: string) => [hint, messageFor(id) ? errorId(id) : undefined].filter(Boolean).join(' ') || undefined;
  // The key's own 409s read under the key; everything else (including the summary of semantic problems) is an alert above the form.
  const generic = view !== null && view.form !== 'field';

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-busy={pending} className="space-y-5">
      <div ref={summary}>
        {problem && generic && (
          <FlagProblemAlert problem={problem} op="create" flagKey={key} token={problem} onCountdownActive={setCountdownActive} />
        )}
      </div>
      <fieldset disabled={pending} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="flag-key">Key</Label>
          <Input
            id="flag-key"
            name="key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            maxLength={64}
            pattern={FLAG_KEY_PATTERN.source}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={messageFor('flag-key') ? true : undefined}
            aria-describedby={describe('flag-key', 'flag-key-hint')}
          />
          <p id="flag-key-hint" className="text-xs text-muted-foreground">
            Lowercase letters, digits and hyphens. It cannot be changed later.
          </p>
          {messageFor('flag-key') && (
            <p id={errorId('flag-key')} className="text-sm text-destructive">
              {messageFor('flag-key')}{' '}
              {view?.action === 'open-flag' && (
                <Link href={flagHref(key.trim())} className="underline underline-offset-2">
                  Open {key.trim()}
                </Link>
              )}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="flag-description">
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="flag-description"
            name="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={FLAG_LIMITS.description}
            rows={3}
            aria-invalid={messageFor('flag-description') ? true : undefined}
            aria-describedby={describe('flag-description')}
          />
          {messageFor('flag-description') && (
            <p id={errorId('flag-description')} className="text-sm text-destructive">
              {messageFor('flag-description')}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="flag-owner">Owner</Label>
          <Input
            id="flag-owner"
            name="owner"
            value={owner}
            onChange={(event) => {
              setOwnerTouched(true);
              setOwner(event.target.value);
            }}
            maxLength={FLAG_LIMITS.owner}
            autoComplete="off"
            aria-invalid={messageFor('flag-owner') ? true : undefined}
            aria-describedby={describe('flag-owner')}
          />
          {messageFor('flag-owner') && (
            <p id={errorId('flag-owner')} className="text-sm text-destructive">
              {messageFor('flag-owner')}
            </p>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          The flag starts disabled: everyone gets the off variant until you enable it and save. You can add variants and rules afterwards.
        </p>
      </fieldset>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
          <Link href={LIST_PATH}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={pending || countdownActive} aria-busy={pending} className="min-h-11 sm:min-h-8">
          {pending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {pending ? 'Creating…' : 'Create flag'}
        </Button>
      </div>
    </form>
  );
}
