/** The status machine of a photo (S29 AS-49). Pure: no framework, no clock. */
export const MEDIA_STATUSES = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'REJECTED',
  'EXPIRED',
  'DELETED',
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const assertNever = (value: never): never => {
  throw new Error(`unhandled case: ${String(value)}`);
};

/** Statuses reachable from `from` (the whole table of AS-49). `PROCESSING → PROCESSING` is the lease takeover. */
export const nextStatuses = (from: MediaStatus): readonly MediaStatus[] => {
  switch (from) {
    case 'PENDING_UPLOAD':
      return ['UPLOADED', 'PROCESSING', 'REJECTED', 'EXPIRED', 'DELETED'];
    case 'UPLOADED':
      return ['PROCESSING'];
    case 'PROCESSING':
      return ['READY', 'REJECTED', 'PROCESSING'];
    case 'READY':
    case 'REJECTED':
    case 'EXPIRED':
      return ['DELETED'];
    case 'DELETED':
      return [];
    default:
      return assertNever(from);
  }
};

export class IllegalMediaTransitionError extends Error {
  constructor(from: MediaStatus, to: MediaStatus) {
    super(`illegal media transition ${from} -> ${to}`);
    this.name = 'IllegalMediaTransitionError';
  }
}

export const canTransition = (from: MediaStatus, to: MediaStatus): boolean =>
  nextStatuses(from).includes(to);

export const assertTransition = (from: MediaStatus, to: MediaStatus): void => {
  if (!canTransition(from, to)) throw new IllegalMediaTransitionError(from, to);
};

/** `tenancy.shop_deleted` forces `DELETED` from any live status (AS-40); the user-facing table above does not. */
export const FORCED_DELETE_FROM: readonly MediaStatus[] = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'REJECTED',
  'EXPIRED',
];

export const isTerminalForWorker = (status: MediaStatus): boolean =>
  status === 'READY' ||
  status === 'REJECTED' ||
  status === 'EXPIRED' ||
  status === 'DELETED';
