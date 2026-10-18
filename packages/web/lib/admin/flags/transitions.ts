import type { Flag } from '@marketplace-sandbox/contracts';

export type LifecycleAction = 'kill' | 'restore' | 'archive';

/** Which lifecycle actions the console offers per status (W06 FR-031). Presentation only: S38 re-checks every move. */
export function availableActions(status: Flag['status']): LifecycleAction[] {
  switch (status) {
    case 'enabled':
      return ['kill'];
    case 'disabled':
      return ['kill', 'archive'];
    case 'killed':
      return ['restore', 'archive'];
    default:
      return [];
  }
}
