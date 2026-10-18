import { Injectable } from '@nestjs/common';
import type { ToxicityClassifier } from '../domain/live-ports';
import { HeuristicToxicityClassifier } from './heuristic-toxicity.classifier';

/**
 * The classifier of the local profile (`PROVIDER_DOUBLES=enabled`, refused in production by the config rules; J03 G-43):
 * a comment carrying the marker `[[toxic]]` scores 0.95, anything else 0.05, so a journey makes moderation decide by what
 * it writes. The default threshold lies between the two.
 */
@Injectable()
export class ScriptedToxicityClassifier implements ToxicityClassifier {
  score(text: string): Promise<number> {
    return Promise.resolve(text.includes('[[toxic]]') ? 0.95 : 0.05);
  }
}

/** The classifier behind the port: the double only where the config switch asks for it. */
export const toxicityClassifierFor = (
  providerDoubles: string | undefined,
): ToxicityClassifier =>
  providerDoubles === 'enabled'
    ? new ScriptedToxicityClassifier()
    : new HeuristicToxicityClassifier();
