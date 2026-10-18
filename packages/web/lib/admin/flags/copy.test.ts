import { describe, expect, it } from 'vitest';
import { FLAG_LIMITS } from '@marketplace-sandbox/contracts';
import { flagProblemCopy } from './copy';
import type { FlagProblem } from './problem';

const problem = (patch: Partial<FlagProblem>): FlagProblem => ({ status: 500, fieldErrors: [], ...patch });
const key = 'new-checkout';

describe('flagProblemCopy', () => {
  it('W06 AS-27: a save without an answer keeps the draft and offers Try again', () => {
    expect(flagProblemCopy(problem({ status: 0 }), { op: 'save', key })).toMatchObject({
      form: 'alert',
      message: "Couldn't reach the server. Your changes haven't been confirmed. Check your connection and try again.",
      action: 'retry',
    });
  });

  it('W06 AS-52: any other call without an answer says so plainly', () => {
    for (const op of ['create', 'kill', 'restore', 'archive'] as const) {
      expect(flagProblemCopy(problem({ status: 0 }), { op, key })).toMatchObject({ form: 'alert', message: "Couldn't reach the server. Check your connection and try again." });
    }
    expect(flagProblemCopy(problem({ status: 0 }), { op: 'list' })).toMatchObject({ form: 'panel', action: 'retry' });
  });

  it('W06 AS-49: a final 401 is the session-ended flow', () => {
    expect(flagProblemCopy(problem({ status: 401, code: 'session_expired' }), { op: 'save', key }).form).toBe('session');
  });

  it('W06 AS-48: 403 is the forbidden panel; csrf and origin are a reload', () => {
    expect(flagProblemCopy(problem({ status: 403, code: 'permission_denied' }), { op: 'list' }).form).toBe('forbidden');
    for (const code of ['csrf_invalid', 'origin_not_allowed']) {
      expect(flagProblemCopy(problem({ status: 403, code }), { op: 'save', key })).toMatchObject({
        form: 'alert',
        message: "We couldn't verify this request. Reload the page and try again.",
        action: 'reload',
      });
    }
  });

  it('W06 AS-31: 404 is the not-found page on a read and an alert in an action', () => {
    expect(flagProblemCopy(problem({ status: 404, code: 'flag_not_found' }), { op: 'detail', key })).toMatchObject({ form: 'notfound', message: "We couldn't find that flag.", action: 'all-flags' });
    expect(flagProblemCopy(problem({ status: 404, code: 'flag_not_found' }), { op: 'history', key }).form).toBe('notfound');
    expect(flagProblemCopy(problem({ status: 404, code: 'flag_not_found' }), { op: 'save', key })).toMatchObject({ form: 'alert', message: "We couldn't find that flag." });
    expect(flagProblemCopy(problem({ status: 404, code: 'flag_not_found' }), { op: 'kill', key }).form).toBe('alert');
  });

  it('W06 AS-42: an invalid cursor is a panel that leads to the first page', () => {
    expect(flagProblemCopy(problem({ status: 400, code: 'invalid_cursor' }), { op: 'history', key })).toMatchObject({
      form: 'panel',
      message: 'That page link is no longer valid.',
      action: 'first-page',
    });
    expect(flagProblemCopy(problem({ status: 400, code: 'invalid_cursor' }), { op: 'list' }).action).toBe('first-page');
  });

  it('W06 AS-15: validation_failed lists every field in the summary', () => {
    const view = flagProblemCopy(problem({ status: 400, code: 'validation_failed', fieldErrors: [{ path: 'owner', code: 'invalid' }, { path: 'unknownField', code: 'invalid' }] }), { op: 'save', key });
    expect(view.form).toBe('summary');
    expect(view.issues).toEqual([
      { path: 'owner', fieldId: 'flag-owner', label: 'Owner', message: "This value isn't valid." },
      { path: 'unknownField', fieldId: null, label: null, message: "This value isn't valid." },
    ]);
  });

  it('W06 AS-28: a version conflict on save is a banner with the current version; on create it is the key field', () => {
    expect(flagProblemCopy(problem({ status: 409, code: 'version_conflict', currentVersion: 5 }), { op: 'save', key })).toMatchObject({
      form: 'banner',
      message: `${key} was changed by someone else (now version 5). Your changes haven't been saved.`,
      action: 'load-latest',
      currentVersion: 5,
    });
    expect(flagProblemCopy(problem({ status: 409, code: 'version_conflict', currentVersion: 1 }), { op: 'create', key })).toMatchObject({
      form: 'field',
      field: 'key',
      message: 'A flag with this key already exists.',
      action: 'open-flag',
    });
  });

  it('W06 AS-35: flag_killed on save names the key and refetches', () => {
    expect(flagProblemCopy(problem({ status: 409, code: 'flag_killed' }), { op: 'save', key })).toMatchObject({
      form: 'alert',
      message: `${key} was killed while you were editing. It can't be enabled until it is restored.`,
      refetch: true,
    });
  });

  it('W06 AS-38: flag_archived differs for create and for the rest', () => {
    expect(flagProblemCopy(problem({ status: 409, code: 'flag_archived' }), { op: 'create', key })).toMatchObject({
      form: 'field',
      field: 'key',
      message: "This key belonged to an archived flag and can't be reused.",
    });
    for (const op of ['save', 'kill', 'restore', 'archive'] as const) {
      expect(flagProblemCopy(problem({ status: 409, code: 'flag_archived' }), { op, key })).toMatchObject({ form: 'alert', message: `${key} was archived and can't be changed.`, refetch: true });
    }
  });

  it('W06 AS-38: invalid_transition names the current status and refetches', () => {
    expect(flagProblemCopy(problem({ status: 409, code: 'invalid_transition', currentStatus: 'killed' }), { op: 'archive', key })).toMatchObject({
      form: 'alert',
      message: `${key} is now killed, so that isn't possible. The page has been refreshed.`,
      refetch: true,
    });
  });

  it('W06 AS-13: flag_limit_reached quotes the limit and links to the stale report', () => {
    expect(flagProblemCopy(problem({ status: 422, code: 'flag_limit_reached' }), { op: 'create', key })).toMatchObject({
      form: 'alert',
      message: `The limit of ${FLAG_LIMITS.flags} active flags is reached. Archive a flag you no longer need, then try again.`,
      action: 'review-stale',
    });
  });

  it('W06 AS-14: flag_definition_invalid maps each {path, code} to a field and its copy', () => {
    const view = flagProblemCopy(
      problem({
        status: 422,
        code: 'flag_definition_invalid',
        fieldErrors: [
          { path: 'rules[0].rollout', code: 'weights_sum_invalid', sum: 9000 },
          { path: 'variants[2].value', code: 'value_too_large' },
          { path: 'mystery', code: 'new_code' },
        ],
      }),
      { op: 'save', key },
    );
    expect(view.form).toBe('summary');
    expect(view.issues).toEqual([
      { path: 'rules[0].rollout', fieldId: 'rule-0-rollout', label: 'Rule 1 rollout', message: 'Weights must add up to 100%. They add up to 90%.' },
      { path: 'variants[2].value', fieldId: 'variant-2-value', label: 'Variant 3 value', message: `This value is too large (${FLAG_LIMITS.valueBytes / 1024} KiB at most).` },
      { path: 'mystery', fieldId: null, label: null, message: "This value isn't valid.", title: 'new_code' },
    ]);
  });

  it('W06 AS-50: 429 is a countdown from Retry-After', () => {
    expect(flagProblemCopy(problem({ status: 429, code: 'rate_limited', retryAfterSeconds: 12 }), { op: 'save', key })).toMatchObject({ form: 'countdown', retryAfterSeconds: 12 });
    expect(flagProblemCopy(problem({ status: 429 }), { op: 'list' }).form).toBe('countdown');
  });

  it('W06 AS-51: 5xx is generic with the reference, never the server text', () => {
    expect(flagProblemCopy(problem({ status: 503, requestId: 'req-1' }), { op: 'list' })).toMatchObject({ form: 'panel', message: 'Something went wrong on our side.', reference: 'req-1', action: 'retry' });
    expect(flagProblemCopy(problem({ status: 500, requestId: 'req-2' }), { op: 'kill', key })).toMatchObject({ form: 'alert', message: 'Something went wrong on our side.', reference: 'req-2' });
    expect(flagProblemCopy(problem({ status: 502 }), { op: 'save', key }).reference).toBeUndefined();
  });

  it('W06 FR-050: 413 and an unknown code fall to fixed copy', () => {
    expect(flagProblemCopy(problem({ status: 413, code: 'payload_too_large' }), { op: 'save', key }).message).toBe('This flag is too large to save. Remove variants, rules or long values.');
    expect(flagProblemCopy(problem({ status: 418, code: 'teapot' }), { op: 'save', key }).message).toBe('Something went wrong on our side.');
  });
});
