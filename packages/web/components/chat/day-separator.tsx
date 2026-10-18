/** "Today", "Yesterday" or a date between two days of messages (W05 AS-22). */
export function DaySeparator({ label }: { label: string }) {
  return (
    <p data-testid="day-separator" className="my-3 text-center text-xs font-medium text-muted-foreground">
      {label}
    </p>
  );
}
