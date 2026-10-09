import { SetMetadata } from '@nestjs/common';
import type { Priority } from './shedding-policy';

/** Metadata key lives here, not next to the gate that reads it, so the decorator and the gate never import each other. */
export const LOAD_SHEDDING_PRIORITY = Symbol('load-shedding-priority');

/** Route (or controller) priority under overload: `background` is shed first, `critical` last. Default `default`. */
export const LoadSheddingPriority = (priority: Priority) =>
  SetMetadata(LOAD_SHEDDING_PRIORITY, priority);
