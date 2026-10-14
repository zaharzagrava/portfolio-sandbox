import { Inject, Injectable, Optional } from '@nestjs/common';
import { containsSensitiveData } from '../domain/sensitive-data';
import type { ModerationVerdict, Moderator } from '../domain/ports';

/**
 * The categorical check S46 will supply (hate, violence, ...): `classify` returns the verdict for one text. Bound by the
 * platform when a backend is configured (`moderation_backend`); without one, outside production, the categorical check
 * passes and only the sensitive-data check runs. Production refuses to start without a backend (AS-54).
 */
export interface ModerationBackend {
  classify(
    text: string,
    context: string | null,
    options: { signal: AbortSignal },
  ): Promise<ModerationVerdict>;
}

export const MODERATION_BACKEND = Symbol('S47_MODERATION_BACKEND');

/**
 * INTERIM adapter (S47 R-2, R-3): the pure sensitive-data check plus the backend slot. S46's moderation port replaces
 * this one file.
 */
@Injectable()
export class ModeratorAdapter implements Moderator {
  constructor(
    @Optional()
    @Inject(MODERATION_BACKEND)
    private readonly backend: ModerationBackend | null,
  ) {}

  async moderateInput(
    text: string,
    options: { signal: AbortSignal },
  ): Promise<ModerationVerdict> {
    if (containsSensitiveData(text))
      return { flagged: true, category: 'sensitive_data' };
    return this.backend
      ? this.backend.classify(text, null, options)
      : { flagged: false };
  }

  async moderateOutput(
    text: string,
    context: string,
    options: { signal: AbortSignal },
  ): Promise<ModerationVerdict> {
    return this.backend
      ? this.backend.classify(text, context, options)
      : { flagged: false };
  }
}
