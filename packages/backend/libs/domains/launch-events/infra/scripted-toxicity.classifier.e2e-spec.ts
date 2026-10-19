import { HeuristicToxicityClassifier } from './heuristic-toxicity.classifier';
import {
  ScriptedToxicityClassifier,
  toxicityClassifierFor,
} from './scripted-toxicity.classifier';

describe('Classifier double of the local profile (J03 G-43, S23)', () => {
  const double = new ScriptedToxicityClassifier();

  it('J03 G-43: content with the [[toxic]] marker scores 0.95, any other content 0.05', async () => {
    expect(await double.score('[[toxic]] hello')).toBe(0.95);
    expect(await double.score('you are [[toxic]]')).toBe(0.95);
    expect(await double.score('hello')).toBe(0.05);
    expect(await double.score('you idiot, you loser')).toBe(0.05);
  });

  it('J03 G-43: the double is chosen only by PROVIDER_DOUBLES=enabled', () => {
    expect(toxicityClassifierFor('enabled')).toBeInstanceOf(
      ScriptedToxicityClassifier,
    );
    for (const value of [undefined, '', 'disabled'])
      expect(toxicityClassifierFor(value)).toBeInstanceOf(
        HeuristicToxicityClassifier,
      );
  });
});
