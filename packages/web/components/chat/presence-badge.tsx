/** "Seller online" in the chat header: a dot together with the words, never colour alone (W05 AS-34, AS-39). Nothing is shown otherwise. */
export function PresenceBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className="size-2 rounded-full bg-green-600" />
      Seller online
    </span>
  );
}
