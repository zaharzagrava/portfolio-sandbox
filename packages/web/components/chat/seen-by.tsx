/** "Seen" or "Seen by n" under the member's newest message that others have read (W05 AS-33). Only ever shown from real positions. */
export function SeenBy({ label }: { label: string }) {
  return (
    <p data-testid="seen-by" className="mt-1 text-right text-xs opacity-90">
      {label}
    </p>
  );
}
