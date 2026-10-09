/**
 * Everything for one period shares a hash tag → one Lua script updates every
 * board of the period atomically (idempotency marker + revenue + scores) on
 * a single cluster slot. Different periods land on different shards.
 */
export const boardKey = (periodId: string, board: string) =>
  `lb:{${periodId}}:z:${board}`;
export const revenueKey = (periodId: string, board: string) =>
  `lb:{${periodId}}:rev:${board}`;
export const seenKey = (periodId: string) => `lb:{${periodId}}:seen`;
/** Which boards exist in a period (for snapshots) - SCAN would only see one node of a cluster. */
export const boardsKey = (periodId: string) => `lb:{${periodId}}:boards`;
export const ALL = 'all';
export const categoryBoard = (category: string) =>
  `cat:${category.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
