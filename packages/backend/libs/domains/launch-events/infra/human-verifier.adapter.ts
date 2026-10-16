import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import type { HumanVerifier } from '../domain/ports';

/** Provider answer; anything else is a provider fault. */
const answerSchema = z.object({ success: z.boolean() });
const TIMEOUT_MS = 2_000;

/**
 * The bot-check provider (S22 FR-012, IV.8): one verification call, 2 s timeout, answer validated. A timeout, a 5xx or an
 * answer of the wrong shape throws, so the caller fails closed; there is no retry (at most one attempt per join).
 */
@Injectable()
export class HttpHumanVerifier implements HumanVerifier {
  constructor(private readonly config: ApiConfigService) {}

  async verify(result: string): Promise<boolean> {
    const url = this.config.get('launch_human_check_url');
    if (!url) throw new Error('human check provider is not configured');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: this.config.get('launch_human_check_secret'),
        response: result,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`provider answered ${response.status}`);
    return answerSchema.parse(await response.json()).success;
  }
}
