/** Store item names. One hash tag per decision keeps every item of it in one shard (FR-013, AS-73). */
export const hashTag = (policy: string, subject: string): string =>
  `{${policy}|${subject}}`;

export const tokenBucketKey = (policy: string, subject: string): string =>
  `rl:${hashTag(policy, subject)}:tb`;

export const concurrencyKey = (policy: string, subject: string): string =>
  `rl:${hashTag(policy, subject)}:cc`;

export const slidingWindowKeys = (
  policy: string,
  subject: string,
  index: number,
): { current: string; previous: string } => ({
  current: `rl:${hashTag(policy, subject)}:sw:${index}`,
  previous: `rl:${hashTag(policy, subject)}:sw:${index - 1}`,
});

/** Base shared by the sliding-window items, used by the scripts to derive the window keys inside one atomic step. */
export const slidingWindowBase = (policy: string, subject: string): string =>
  `rl:${hashTag(policy, subject)}:sw:`;
