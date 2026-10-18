'use client';

import type { FlagProblem } from '@/lib/admin/flags/problem';
import { FlagProblemAlert } from './flag-problem';

/**
 * Two admins: the later save is refused, not merged and not lost (W06 AS-28). A warning `role="alert"` with the current
 * version, **Load latest** (replaces the form after the discard confirmation) and **Keep editing** (dismisses the banner; the
 * draft stays so its values can be copied).
 */
export function ConflictBanner({ problem, flagKey, onLoadLatest, onKeepEditing }: { problem: FlagProblem; flagKey: string; onLoadLatest: () => void; onKeepEditing: () => void }) {
  return <FlagProblemAlert problem={problem} op="save" flagKey={flagKey} onLoadLatest={onLoadLatest} onKeepEditing={onKeepEditing} />;
}
