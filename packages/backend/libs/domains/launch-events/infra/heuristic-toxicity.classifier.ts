import { Injectable } from '@nestjs/common';
import type { ToxicityClassifier } from '../domain/live-ports';

/**
 * The default classifier behind the `ToxicityClassifier` port (IV.8): a heuristic scorer. The real adapter is a
 * moderation endpoint (Perspective API or an LLM) bound to the same port.
 */
@Injectable()
export class HeuristicToxicityClassifier implements ToxicityClassifier {
  score(text: string): Promise<number> {
    const shouting =
      text.length > 12 && text === text.toUpperCase() && /[A-Z]/.test(text)
        ? 0.3
        : 0;
    const repeated = /(.)\1{6,}/.test(text) ? 0.3 : 0;
    const insults = /\b(idiot|stupid|trash|loser)\b/i.test(text) ? 0.6 : 0;
    return Promise.resolve(Math.min(1, shouting + repeated + insults));
  }
}
