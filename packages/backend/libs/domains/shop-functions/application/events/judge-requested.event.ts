import { z } from 'zod';

/**
 * The judge request (S45 FR-011, IV.3): an outbox task appended in the submit transaction and relayed to the
 * single-consumer queue. The queue is a standard queue, so no FIFO-only option (`groupId`, `dedupeId`) is ever set (L-001).
 */
export const JUDGE_QUEUE = 'shop-functions-judge-version';
export const JUDGE_REQUESTED_TYPE = 'shop_functions.judge_requested';

export const judgeRequestSchema = z
  .object({
    functionId: z.string().uuid(),
    version: z.number().int().min(1),
  })
  .strict();
export type JudgeRequest = z.infer<typeof judgeRequestSchema>;

/** Validates the payload where the task is created, so the relay never discovers a bad one. */
export function judgeRequestTask(request: JudgeRequest) {
  const body = judgeRequestSchema.parse(request);
  return {
    queue: JUDGE_QUEUE,
    type: JUDGE_REQUESTED_TYPE,
    aggregateId: body.functionId,
    body,
  };
}
