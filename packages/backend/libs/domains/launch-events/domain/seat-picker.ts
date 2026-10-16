/**
 * Best-available choice (S22 FR-020): from the seats believed free, pick `quantity` of them, preferring adjacent seats of
 * one row. Pure: the random source comes in, so two concurrent callers land on different runs and rarely collide.
 * The ledger decides in the end; a collision just means the caller excludes that seat and picks again.
 */
export interface Run {
  start: number;
  length: number;
}

/** Maximal runs of consecutive seat numbers inside one row. `free` must be sorted ascending. */
export const freeRuns = (
  free: readonly number[],
  seatsPerRow: number,
): Run[] => {
  const runs: Run[] = [];
  for (const seat of free) {
    const last = runs[runs.length - 1];
    if (
      last &&
      seat === last.start + last.length &&
      Math.floor(seat / seatsPerRow) === Math.floor(last.start / seatsPerRow)
    )
      last.length += 1;
    else runs.push({ start: seat, length: 1 });
  }
  return runs;
};

export const pickSeats = (input: {
  free: readonly number[];
  quantity: number;
  seatsPerRow: number;
  random: () => number;
}): number[] | null => {
  const { free, quantity, seatsPerRow, random } = input;
  if (quantity < 1 || free.length < quantity) return null;
  const runs = freeRuns(free, seatsPerRow);
  const fitting = runs.filter((run) => run.length >= quantity);
  if (fitting.length > 0) {
    const run = fitting[Math.floor(random() * fitting.length)];
    const offset = Math.floor(random() * (run.length - quantity + 1));
    return Array.from({ length: quantity }, (_, i) => run.start + offset + i);
  }
  // No row has room for the whole group: fill from the longest runs, longest first.
  const picked: number[] = [];
  for (const run of [...runs].sort((a, b) => b.length - a.length)) {
    for (let i = 0; i < run.length && picked.length < quantity; i++)
      picked.push(run.start + i);
    if (picked.length === quantity) break;
  }
  return picked.sort((a, b) => a - b);
};
