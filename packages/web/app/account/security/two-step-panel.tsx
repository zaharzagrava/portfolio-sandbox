'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { confirmMfa, disableMfa, enrollMfa, getMfaStatus, regenerateRecoveryCodes } from '@/lib/api/account';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { problemMessage } from '@/lib/auth/copy';
import { queryKeys } from '@/lib/query-keys';
import { CodeDialog, CodeForm, STALE } from './code-dialog';
import { DESTRUCTIVE_TEXT, SHEET_DIALOG } from './dialog-styles';
import { QrCode } from './qr-code';
import { RecoveryCodesDialog } from './recovery-codes-dialog';

type Enrolment = { otpauthUri: string; manualEntryKey: string };
type Modal = { kind: 'setup'; enrolment: Enrolment } | { kind: 'regenerate' } | { kind: 'disable' } | null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' });

/** The "Two-step verification" tab (W01 US8, AS-45..AS-52). Every change of the factor asks for a fresh code. */
export function TwoStepPanel() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: queryKeys.auth.mfaStatus(), queryFn: getMfaStatus });
  const [modal, setModal] = useState<Modal>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [starting, setStarting] = useState(false);
  const starts = useRef(false);

  const refetch = () => queryClient.invalidateQueries({ queryKey: queryKeys.auth.mfaStatus() });

  /** A stale-status answer: close the dialog, read the real status again, say what the real situation is. */
  function reconcile(problem: Problem) {
    setModal(null);
    void refetch();
    toast.error(problemMessage(problem, 'mfa-setup'));
  }

  async function startSetup() {
    if (starts.current) return;
    starts.current = true;
    setStarting(true);
    try {
      setModal({ kind: 'setup', enrolment: await enrollMfa() });
    } catch (error) {
      const problem = problemFromError(error);
      if (problem.code && STALE.has(problem.code)) reconcile(problem);
      else toast.error(problemMessage(problem, 'mfa-setup'));
    } finally {
      starts.current = false;
      setStarting(false);
    }
  }

  function showCodes(next: string[]) {
    setModal(null);
    setCodes(next);
    void refetch();
  }

  if (status.isPending) {
    return (
      <div data-testid="two-step-skeleton" aria-busy="true" className="grid gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-9 w-40" />
      </div>
    );
  }

  if (status.isError) {
    return (
      <div className="grid gap-3">
        <p role="alert">We couldn&apos;t load this section.</p>
        <div>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={() => void status.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const current = status.data;
  const left = current.recoveryCodesRemaining;
  return (
    <section aria-labelledby="two-step-heading" className="grid gap-4">
      <h2 id="two-step-heading" className="text-lg font-semibold">
        Two-step verification
      </h2>
      {current.state === 'none' && (
        <>
          <p>Two-step verification is off.</p>
          <p className="text-sm text-muted-foreground">Add a code from an authenticator app to protect your account beyond your password.</p>
          <div>
            <Button type="button" className="min-h-11 sm:min-h-0" disabled={starting} onClick={() => void startSetup()}>
              {starting && <Loader2 className="animate-spin" aria-hidden="true" />}
              Set up
            </Button>
          </div>
        </>
      )}
      {current.state === 'pending' && (
        <>
          <p>Setup wasn&apos;t finished.</p>
          <p className="text-sm text-muted-foreground">The key from the earlier attempt can&apos;t be shown again. Start over to get a new one.</p>
          <div>
            <Button type="button" className="min-h-11 sm:min-h-0" disabled={starting} onClick={() => void startSetup()}>
              {starting && <Loader2 className="animate-spin" aria-hidden="true" />}
              Start over
            </Button>
          </div>
        </>
      )}
      {current.state === 'enabled' && (
        <>
          <p>{current.enabledAt ? `Two-step verification is on since ${formatDate(current.enabledAt)}.` : 'Two-step verification is on.'}</p>
          {left !== undefined && <p className="text-sm text-muted-foreground">{`${plural(left, 'recovery code')} left`}</p>}
          {left !== undefined && left <= 3 && (
            <p role="status" className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {left === 0 ? 'You have no recovery codes left. Get new ones now.' : `Only ${plural(left, 'recovery code')} left. Get new ones soon.`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={() => setModal({ kind: 'regenerate' })}>
              Get new recovery codes
            </Button>
            <Button type="button" variant="destructive" className={`min-h-11 sm:min-h-0 ${DESTRUCTIVE_TEXT}`} onClick={() => setModal({ kind: 'disable' })}>
              Turn off
            </Button>
          </div>
        </>
      )}

      {modal?.kind === 'setup' && <SetupDialog enrolment={modal.enrolment} onClose={() => setModal(null)} onCodes={showCodes} onStale={reconcile} />}
      {modal?.kind === 'regenerate' && (
        <CodeDialog
          title="Get new recovery codes"
          description="Your old recovery codes stop working. Enter the current code from your authenticator app to continue."
          label="Authentication code"
          hint="Use the code from your authenticator app"
          mode="totp"
          submitLabel="Get new codes"
          onClose={() => setModal(null)}
          onStale={reconcile}
          run={async (code) => showCodes((await regenerateRecoveryCodes(code)).recoveryCodes)}
        />
      )}
      {modal?.kind === 'disable' && (
        <CodeDialog
          title="Turn off two-step verification"
          description="Your account will be protected by your password only."
          label="Authenticator or recovery code"
          hint="Enter the 6-digit code from your authenticator app, or a recovery code."
          mode="recovery"
          submitLabel="Turn off"
          destructive
          onClose={() => setModal(null)}
          onStale={reconcile}
          run={async (code) => {
            await disableMfa(code);
            setModal(null);
            void refetch();
            toast.success('Two-step verification is off.');
          }}
        />
      )}
      {codes && <RecoveryCodesDialog codes={codes} onDone={() => setCodes(null)} />}
    </section>
  );
}

/** Steps 1 and 2 of setup (key, then code); step 3 is the recovery-codes dialog the panel opens next. */
function SetupDialog({
  enrolment,
  onClose,
  onCodes,
  onStale,
}: {
  enrolment: Enrolment;
  onClose: () => void;
  onCodes: (codes: string[]) => void;
  onStale: (problem: Problem) => void;
}) {
  const [step, setStep] = useState<'key' | 'code'>('key');
  async function copyKey() {
    try {
      await navigator.clipboard.writeText(enrolment.manualEntryKey);
      toast.success('Key copied.');
    } catch {
      toast.error("We couldn't copy the key. Select it and copy by hand.");
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={SHEET_DIALOG}>
        <DialogHeader>
          <DialogTitle>Set up two-step verification</DialogTitle>
          <DialogDescription>
            {step === 'key'
              ? 'Step 1 of 3. Scan the QR code with your authenticator app, or type the setup key into it.'
              : 'Step 2 of 3. Enter the 6-digit code your authenticator app shows.'}
          </DialogDescription>
        </DialogHeader>
        {step === 'key' ? (
          <>
            <div className="flex justify-center">
              <QrCode value={enrolment.otpauthUri} />
            </div>
            <div className="grid gap-2">
              <p className="text-sm font-medium">Setup key</p>
              <code className="break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm select-all">{enrolment.manualEntryKey}</code>
              <div>
                <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={() => void copyKey()}>
                  Copy key
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" className="min-h-11 sm:min-h-0" onClick={() => setStep('code')}>
                Next
              </Button>
            </DialogFooter>
          </>
        ) : (
          <CodeForm
            label="6-digit code"
            mode="totp"
            submitLabel="Confirm"
            onClose={onClose}
            onBack={() => setStep('key')}
            onStale={onStale}
            run={async (code) => onCodes((await confirmMfa(code)).recoveryCodes)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

