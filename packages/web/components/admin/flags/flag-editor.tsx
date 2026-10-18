'use client';

import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { Flag, FlagInput } from '@marketplace-sandbox/contracts';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ForbiddenPanel } from '@/components/admin/forbidden-panel';
import { useFlag, useFlagWriteBusy, useSaveFlag } from '@/hooks/use-admin-flags';
import { flagProblemCopy } from '@/lib/admin/flags/copy';
import { draftReducer, isDirty, toDraft } from '@/lib/admin/flags/draft';
import { setDraftDirty } from '@/lib/admin/flags/dirty';
import type { FlagProblem } from '@/lib/admin/flags/problem';
import { toFlagInput, type FieldIssue } from '@/lib/admin/flags/to-flag-input';
import { readFlagProblem } from '@/lib/api/admin-flags';
import { BasicsSection } from './basics-section';
import { BindingsSection } from './bindings-section';
import { ConflictBanner } from './conflict-banner';
import { DANGER_BUTTON } from './danger';
import { EditorHeader } from './editor-header';
import { EditorSkeleton } from './editor-skeleton';
import { FlagProblemAlert } from './flag-problem';
import { HelpCard } from './help-card';
import { LifecycleDialog } from './lifecycle-dialogs';
import { StateNotice } from './notices';
import { RulesEditor } from './rules-editor';
import { SaveBar } from './save-bar';
import { UnsavedGuard } from './unsaved-guard';
import { VariantsEditor } from './variants-editor';
import type { LifecycleAction } from '@/lib/admin/flags/transitions';

const ALERT =
  'rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 outline-none dark:border-red-900 dark:bg-red-950/60 dark:text-red-100 focus-visible:ring-3 focus-visible:ring-ring/50';

/** A readable name for the control a syntax error points at (the summary lists these as links). */
function labelOf(id: string): string {
  const variant = /^variant-(\d+)-value$/.exec(id);
  if (variant) return `Variant ${Number(variant[1]) + 1} value`;
  const condition = /^rule-(\d+)-condition-(\d+)-values$/.exec(id);
  if (condition) return `Rule ${Number(condition[1]) + 1} condition ${Number(condition[2]) + 1} values`;
  const rollout = /^rule-(\d+)-rollout$/.exec(id);
  if (rollout) return `Rule ${Number(rollout[1]) + 1} rollout`;
  return id;
}

/**
 * The flag editor (W06 AS-17..AS-31, AS-33..AS-35): opens the flag, keeps a local draft (initialised from the flag, reset only from
 * a save answer, Load latest or Discard: a refetch updates the header and badges, never the draft), saves the whole definition with the
 * version it was based on, and reports every failure where the catalogue says. Kill, restore and archive go through their own
 * dialogs and never through Save.
 */
export function FlagEditor({ flagKey, tabs }: { flagKey: string; tabs?: ReactNode }) {
  const query = useFlag(flagKey);
  if (!query.data) {
    if (query.isError) return <FlagProblemAlert problem={readFlagProblem(query.error)} op="detail" flagKey={flagKey} onRetry={() => void query.refetch()} />;
    return <EditorSkeleton />;
  }
  return <EditorBody key={flagKey} flag={query.data} reload={async () => (await query.refetch()).data} tabs={tabs} />;
}

function EditorBody({ flag, reload, tabs }: { flag: Flag; reload: () => Promise<Flag | undefined>; tabs?: ReactNode }) {
  const [draft, dispatch] = useReducer(draftReducer, flag, toDraft);
  const [loaded, setLoaded] = useState(flag);
  const [problem, setProblem] = useState<FlagProblem | null>(null);
  const [conflict, setConflict] = useState<FlagProblem | null>(null);
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [syntax, setSyntax] = useState<FieldIssue[]>([]);
  const [saved, setSaved] = useState(false);
  const [countdown, setCountdown] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [lifecycle, setLifecycle] = useState<LifecycleAction | null>(null);
  const [confirm, setConfirm] = useState<'discard' | 'load-latest' | null>(null);
  const lastInput = useRef<FlagInput | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const save = useSaveFlag(flag.key);
  const busy = useFlagWriteBusy();

  const dirty = isDirty(draft);
  const archived = flag.status === 'archived';
  const killed = flag.status === 'killed';
  const writing = save.isPending || busy;

  // The session-ended toast says the edits are lost, but only while there are some (AS-49).
  useEffect(() => {
    setDraftDirty(dirty);
    return () => setDraftDirty(false);
  }, [dirty]);

  // A clean draft follows the server (someone else saved, a restore happened); a dirty one is never replaced silently.
  // (Adjusting state while rendering, the documented way to follow a prop: React re-renders at once with the new draft.)
  if (!dirty && !save.isPending && flag.version !== draft.basisVersion) {
    dispatch({ type: 'reset', flag });
    setLoaded(flag);
    setConflict(null);
  }

  const view = problem ? flagProblemCopy(problem, { op: 'save', key: flag.key }) : null;
  const issues: Record<string, string> = {};
  for (const issue of view?.issues ?? []) if (issue.fieldId && !issues[issue.fieldId]) issues[issue.fieldId] = issue.message;
  for (const issue of syntax) issues[issue.fieldId] = issue.message;

  // Focus moves to the first problem after a failed submit (FR-061).
  useEffect(() => {
    if (focusTick === 0) return;
    const first = Object.keys(issues)[0];
    const target = first ? document.getElementById(first) : null;
    (target ?? summary.current?.querySelector<HTMLElement>('[role="alert"]'))?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  async function send(input: FlagInput) {
    lastInput.current = input;
    setProblem(null);
    setSaved(false);
    try {
      const next = await save.mutateAsync(input);
      dispatch({ type: 'reset', flag: next });
      setLoaded(next);
      setConflict(null);
      setConflictDismissed(false);
      setSyntax([]);
      setSaved(true);
    } catch (error) {
      const read = readFlagProblem(error);
      const copy = flagProblemCopy(read, { op: 'save', key: flag.key });
      if (copy.form === 'banner') {
        setConflict(read);
        setConflictDismissed(false);
      } else {
        setProblem(read);
      }
      if (copy.refetch) void reload();
      setFocusTick((n) => n + 1);
    }
  }

  function submit() {
    if (!canSave) return;
    const { input, errors } = toFlagInput(draft);
    if (!input) {
      setSyntax(errors);
      setProblem(null);
      setFocusTick((n) => n + 1);
      return;
    }
    setSyntax([]);
    void send(input);
  }

  async function loadLatest() {
    const latest = await reload();
    if (!latest) return;
    dispatch({ type: 'reset', flag: latest });
    setLoaded(latest);
    setConflict(null);
    setProblem(null);
    setSyntax([]);
  }

  const killedBlocked = killed && draft.enabled;
  const canSave = dirty && !writing && !archived && !conflict && !countdown && !killedBlocked;
  const blockedReason = conflict ? 'Load the latest version before saving.' : killedBlocked ? "A killed flag can't be enabled. Turn off Enabled, or restore the flag first." : undefined;

  if (view?.form === 'forbidden') return <ForbiddenPanel />;

  return (
    <div className="space-y-6">
      <UnsavedGuard dirty={dirty} />
      <EditorHeader flag={flag} busy={writing} onAction={setLifecycle} />
      <StateNotice status={flag.status} />
      {tabs}

      <div ref={summary} className="space-y-3 empty:hidden">
        {syntax.length > 0 && (
          <div role="alert" tabIndex={-1} className={ALERT}>
            <p>Some values can&apos;t be sent.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {syntax.map((issue) => (
                <li key={issue.fieldId}>
                  <a href={`#${issue.fieldId}`} className="underline underline-offset-2">
                    {labelOf(issue.fieldId)}: {issue.message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {problem && <FlagProblemAlert problem={problem} op="save" flagKey={flag.key} token={problem} onRetry={() => lastInput.current && void send(lastInput.current)} onCountdownActive={setCountdown} />}
        {conflict && !conflictDismissed && (
          <ConflictBanner problem={conflict} flagKey={flag.key} onLoadLatest={() => (dirty ? setConfirm('load-latest') : void loadLatest())} onKeepEditing={() => setConflictDismissed(true)} />
        )}
      </div>

      <form
        noValidate
        aria-busy={writing}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="space-y-6"
      >
        <fieldset disabled={archived || writing} className="min-w-0 space-y-6 border-0 p-0">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-6 lg:col-start-1 lg:row-start-1">
              <BasicsSection draft={draft} dispatch={dispatch} issues={issues} killed={killed} />
              <VariantsEditor draft={draft} dispatch={dispatch} issues={issues} />
              <BindingsSection draft={draft} dispatch={dispatch} issues={issues} />
            </div>
            <div className="lg:col-span-2 lg:row-start-2">
              <RulesEditor draft={draft} dispatch={dispatch} issues={issues} />
            </div>
            <div className="lg:col-start-2 lg:row-start-1">
              <HelpCard />
            </div>
          </div>
        </fieldset>
        <SaveBar dirty={dirty} saving={save.isPending} saved={saved && !dirty} canSave={canSave} blockedReason={blockedReason} onSave={submit} onDiscard={() => setConfirm('discard')} />
      </form>

      {lifecycle && <LifecycleDialog flagKey={flag.key} action={lifecycle} offVariant={flag.offVariant} onClose={() => setLifecycle(null)} />}
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title="Discard unsaved changes?"
          description={confirm === 'discard' ? 'The form goes back to the saved definition.' : 'The form is replaced with the latest saved definition.'}
          cancelLabel="Keep editing"
          confirmLabel="Discard changes"
          destructive
          confirmClassName={DANGER_BUTTON}
          onConfirm={async () => {
            if (confirm === 'discard') {
              dispatch({ type: 'reset', flag: loaded });
              setProblem(null);
              setSyntax([]);
            } else {
              await loadLatest();
            }
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
