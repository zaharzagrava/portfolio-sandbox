import { FLAG_LIMITS } from '@marketplace-sandbox/contracts';
import type { FlagOp, FlagProblem } from './problem';
import { definitionErrorCopy, fieldForPath } from './problem-paths';

/** How a problem shows (the letters of the spec's error catalogue). */
export type FlagProblemForm = 'session' | 'countdown' | 'forbidden' | 'field' | 'summary' | 'alert' | 'banner' | 'panel' | 'notfound';
export type FlagProblemAction = 'retry' | 'reload' | 'open-flag' | 'review-stale' | 'first-page' | 'load-latest' | 'all-flags';

export type FlagIssue = { path: string; fieldId: string | null; label: string | null; message: string; title?: string };

export type FlagProblemView = {
  form: FlagProblemForm;
  message: string;
  action?: FlagProblemAction;
  /** Request id of a 5xx: shown as "Reference: …" with a Copy button. */
  reference?: string;
  retryAfterSeconds?: number;
  /** `field`: the control the message goes under. */
  field?: 'key';
  issues?: FlagIssue[];
  /** The page refetches the flag after this answer (the state it shows is stale). */
  refetch?: boolean;
  currentVersion?: number;
};

export const GENERIC = 'Something went wrong on our side.';
const NO_ANSWER_SAVE = "Couldn't reach the server. Your changes haven't been confirmed. Check your connection and try again.";
const NO_ANSWER = "Couldn't reach the server. Check your connection and try again.";
const READS: FlagOp[] = ['list', 'detail', 'history', 'stale'];

const issuesOf = (problem: FlagProblem): FlagIssue[] =>
  problem.fieldErrors.map((entry) => {
    const target = fieldForPath(entry.path);
    const copy = problem.code === 'flag_definition_invalid' ? definitionErrorCopy(entry.code, { sum: entry.sum }) : { message: "This value isn't valid." };
    return { path: entry.path, fieldId: target?.id ?? null, label: target?.label ?? null, ...copy };
  });

/**
 * Copy and placement of a failed flag call, keyed by `(status, code)` and the operation, never by the server's `title` or
 * `detail` (W06 FR-050, error catalogue). Pure: the components choose the markup.
 */
export function flagProblemCopy(problem: FlagProblem, ctx: { op: FlagOp; key?: string }): FlagProblemView {
  const { op } = ctx;
  const key = ctx.key ?? 'This flag';
  const read = READS.includes(op);
  const reference = problem.requestId ? { reference: problem.requestId } : {};

  if (problem.status === 0) {
    if (op === 'save') return { form: 'alert', message: NO_ANSWER_SAVE, action: 'retry' };
    return read ? { form: 'panel', message: NO_ANSWER, action: 'retry' } : { form: 'alert', message: NO_ANSWER };
  }
  if (problem.status === 401) return { form: 'session', message: 'Your session ended. Sign in again to continue.' };
  if (problem.status === 429) return { form: 'countdown', message: 'Too many requests.', retryAfterSeconds: problem.retryAfterSeconds };

  if (problem.status === 403) {
    if (problem.code === 'csrf_invalid' || problem.code === 'origin_not_allowed') {
      return { form: 'alert', message: "We couldn't verify this request. Reload the page and try again.", action: 'reload' };
    }
    return { form: 'forbidden', message: "You don't have access to this area." };
  }

  switch (problem.code) {
    case 'flag_not_found':
      return read
        ? { form: 'notfound', message: "We couldn't find that flag.", action: 'all-flags' }
        : { form: 'alert', message: "We couldn't find that flag." };
    case 'invalid_cursor':
      return { form: 'panel', message: 'That page link is no longer valid.', action: 'first-page' };
    case 'validation_failed':
      if (read) break;
      return { form: 'summary', message: 'Some values need attention.', issues: issuesOf(problem) };
    case 'flag_definition_invalid':
      return { form: 'summary', message: 'Some values need attention.', issues: issuesOf(problem) };
    case 'version_conflict':
      if (op === 'create') return { form: 'field', field: 'key', message: 'A flag with this key already exists.', action: 'open-flag' };
      return {
        form: 'banner',
        message: `${key} was changed by someone else (now version ${problem.currentVersion ?? '?'}). Your changes haven't been saved.`,
        action: 'load-latest',
        currentVersion: problem.currentVersion,
      };
    case 'flag_killed':
      return { form: 'alert', message: `${key} was killed while you were editing. It can't be enabled until it is restored.`, refetch: true };
    case 'flag_archived':
      if (op === 'create') return { form: 'field', field: 'key', message: "This key belonged to an archived flag and can't be reused." };
      return { form: 'alert', message: `${key} was archived and can't be changed.`, refetch: true };
    case 'invalid_transition':
      return { form: 'alert', message: `${key} is now ${problem.currentStatus ?? 'in another state'}, so that isn't possible. The page has been refreshed.`, refetch: true };
    case 'flag_limit_reached':
      return {
        form: 'alert',
        message: `The limit of ${FLAG_LIMITS.flags} active flags is reached. Archive a flag you no longer need, then try again.`,
        action: 'review-stale',
      };
    case 'payload_too_large':
      return { form: 'alert', message: 'This flag is too large to save. Remove variants, rules or long values.' };
    default:
      break;
  }
  if (problem.status === 413) return { form: 'alert', message: 'This flag is too large to save. Remove variants, rules or long values.' };

  const generic = { message: GENERIC, ...reference, ...(problem.retryAfterSeconds !== undefined ? { retryAfterSeconds: problem.retryAfterSeconds } : {}) };
  return read ? { form: 'panel', action: 'retry', ...generic } : { form: 'alert', ...generic };
}
