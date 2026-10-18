/**
 * What the console needs from a failed flag call (W06 R-02, R-03): the stable machine code (`code`, else the tail of `type`),
 * the 422 `{path, code}` list normalised from `path` or `field`, and the extension members S38 adds to a 409.
 */
export type FlagFieldError = { path: string; code: string; sum?: number };

export type FlagProblem = {
  /** HTTP status; `0` when the request never got an answer. */
  status: number;
  code?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  fieldErrors: FlagFieldError[];
  currentVersion?: number;
  currentStatus?: string;
};

export type FlagOp = 'list' | 'detail' | 'history' | 'stale' | 'save' | 'create' | 'kill' | 'restore' | 'archive';
