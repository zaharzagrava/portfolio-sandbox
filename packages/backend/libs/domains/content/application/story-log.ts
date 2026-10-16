import type { Logger } from '@nestjs/common';

export interface OutcomeFields {
  outcome: string;
  storyId?: string;
  shopId?: string;
  version?: number;
  /** A problem code or a failure class: fixed text, never a value from a request. */
  code?: string;
  lagSeconds?: number;
}

/**
 * One structured line per outcome (S27 AS-96): the story, the shop, the version and what happened. The request id comes
 * from the platform logger's request context. Draft content, tokens and secrets are never fields here.
 */
export function logOutcome(
  logger: Logger,
  event: string,
  fields: OutcomeFields,
): void {
  logger.log({ event, ...fields });
}
