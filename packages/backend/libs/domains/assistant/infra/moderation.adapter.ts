import { Injectable } from '@nestjs/common';
import type {
  ModerationPort,
  ModerationVerdict,
} from '../domain/assistant-ports';
import { ModerationUnavailableError } from '../application/assistant-errors';
import { ModeratorAdapter } from './moderator.adapter';

/** Deadline of one moderation call; a slower backend counts as unavailable and the turn fails closed (AS-55). */
export const MODERATION_DEADLINE_MS = 200;

/**
 * S46 moderation port over the rule-based sensitive-data check and the optional categorical backend (S47's
 * `ModeratorAdapter` slot). Any failure or timeout of the backend is `ModerationUnavailableError`: input and output are
 * never let through unchecked.
 */
@Injectable()
export class AssistantModerationAdapter implements ModerationPort {
  constructor(private readonly moderator: ModeratorAdapter) {}

  checkInput(text: string): Promise<ModerationVerdict> {
    return this.within((signal) =>
      this.moderator.moderateInput(text, { signal }),
    );
  }

  checkOutput(text: string, context: string): Promise<ModerationVerdict> {
    return this.within((signal) =>
      this.moderator.moderateOutput(text, context, { signal }),
    );
  }

  private async within(
    run: (signal: AbortSignal) => Promise<ModerationVerdict>,
  ): Promise<ModerationVerdict> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ModerationUnavailableError());
      }, MODERATION_DEADLINE_MS);
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } catch (error) {
      throw error instanceof ModerationUnavailableError
        ? error
        : new ModerationUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }
}
