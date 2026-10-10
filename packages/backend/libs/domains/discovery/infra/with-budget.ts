/** Thrown when a call did not answer within its budget. The call itself is abandoned, never retried. */
export class BudgetExceededError extends Error {
  constructor(readonly budgetMs: number) {
    super(`call did not answer within ${budgetMs} ms`);
    this.name = 'BudgetExceededError';
  }
}

/** Races `work` against a timer (cleared on either outcome). No retry (S34 R-10). */
export async function withBudget<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExceededError(budgetMs)), budgetMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // the abandoned call may still reject later; nobody awaits it any more
    work.catch(() => undefined);
  }
}
