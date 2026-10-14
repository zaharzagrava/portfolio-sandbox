export const SECURITY_TABS = [
  { id: 'two-step', label: 'Two-step verification' },
  { id: 'sessions', label: 'Active sessions' },
  { id: 'methods', label: 'Sign-in methods' },
] as const;
export type SecurityTab = (typeof SECURITY_TABS)[number]['id'];

/** The `?tab=` value of the URL view state; anything unknown (or repeated) is ignored, never echoed (W01 FR-025). Server-safe. */
export function parseTab(value: string | string[] | undefined | null): SecurityTab {
  return SECURITY_TABS.find((tab) => tab.id === value)?.id ?? 'two-step';
}
