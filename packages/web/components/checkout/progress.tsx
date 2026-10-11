const STEPS = [
  { id: 'review', label: 'Review' },
  { id: 'pay', label: 'Pay' },
] as const;

export type CheckoutProgressStep = (typeof STEPS)[number]['id'];

/** The two-step progress list of the checkout (W03 AS-15): the current step carries `aria-current="step"`. Server-renderable. */
export function CheckoutProgress({ current }: { current: CheckoutProgressStep }) {
  return (
    <nav aria-label="Checkout">
      <ol aria-label="Checkout progress" className="flex items-center gap-3 text-sm">
        {STEPS.map((step) => (
          <li
            key={step.id}
            aria-current={step.id === current ? 'step' : undefined}
            className={`${step.id === current ? 'font-semibold text-foreground' : 'text-muted-foreground'} not-last:after:ml-3 not-last:after:text-muted-foreground not-last:after:content-['→']`}
          >
            {step.label}
          </li>
        ))}
      </ol>
    </nav>
  );
}
