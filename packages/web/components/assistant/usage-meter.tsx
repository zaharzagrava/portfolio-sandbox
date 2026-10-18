import type { AllowanceView } from '@/lib/assistant/problem-copy';

/** The quiet allowance line (W05 AS-47): a percentage a shopper understands, never tokens. Nothing when the read failed. */
export function UsageMeter({ usage }: { usage: AllowanceView | null }) {
  if (!usage) return null;
  return (
    <div className="flex flex-col gap-1 px-4 pb-3">
      <progress aria-label="Monthly allowance used" value={usage.percent} max={100} className="h-1 w-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary" />
      <p className="text-xs text-muted-foreground">{usage.label}</p>
    </div>
  );
}
