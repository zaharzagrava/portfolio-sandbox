/**
 * Exhaustiveness check for discriminated unions (state machines, job types,
 * event types). Adding a new variant without handling it becomes a compile
 * error at every `switch` that ends with `assertNever(x)`.
 */
export function assertNever(
  value: never,
  message = 'Unhandled variant',
): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
