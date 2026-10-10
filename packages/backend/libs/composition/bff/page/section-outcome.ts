import type { SectionName } from '@marketplace-sandbox/contracts';
import type { UpstreamFailure } from '../upstream/upstream-error';

export type SectionOutcome =
  | { name: SectionName; status: 'ok'; value: unknown; durationMs: number }
  | { name: SectionName; status: 'skipped'; value: null; durationMs: 0 }
  | {
      name: SectionName;
      status: 'error';
      value: null;
      failure: UpstreamFailure;
      durationMs: number;
    };
