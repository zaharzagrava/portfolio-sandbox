import type { z } from 'zod';
import type {
  apiVersionStateSchema,
  pinVersionResultSchema,
} from '@marketplace-sandbox/contracts';

export type ApiVersionStateDto = z.infer<typeof apiVersionStateSchema>;
export type PinVersionResultDto = z.infer<typeof pinVersionResultSchema>;
