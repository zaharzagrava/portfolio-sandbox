/** "How a flag is evaluated" in plain words (W06 AS-17): the order of S38 FR-020. */
export function HelpCard() {
  return (
    <aside aria-labelledby="help-heading" className="space-y-2 rounded-xl border bg-background p-4 text-sm lg:sticky lg:top-4">
      <h2 id="help-heading" className="font-semibold">
        How a flag is evaluated
      </h2>
      <p>Killed or disabled: everyone gets the off variant. Otherwise the first rule that matches decides. If no rule matches, the default variant is served.</p>
    </aside>
  );
}
