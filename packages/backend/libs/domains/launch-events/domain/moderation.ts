/**
 * Synchronous, microsecond-cheap checks on the comment hot path. Anything
 * smarter (toxicity models, LLM review) runs async and removes after the fact
 * (`LiveModerationConsumer`) - a 5k/s chat can't wait on a model per message.
 */
const BANNED = ['scam', 'fake', 'counterfeit', 'free iphone', 'click here'];
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

export function normalizeForModeration(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1$1') // "scaaaam" → "scaam"
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function syncModeration(text: string): { ok: true } | { ok: false; reason: string } {
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: 'links are not allowed in live chat' };
  const normalized = normalizeForModeration(text);
  // Re-join letter-spaced evasions ("s c a m") without gluing real words together ("fa keyboard" ≠ "fake").
  const rejoined = normalized.replace(/\b(?:\w ){2,}\w\b/g, (run) => run.replace(/ /g, ''));
  const hit = BANNED.find((w) => [normalized, rejoined].some((t) => new RegExp(`\\b${w}`).test(t)));
  return hit ? { ok: false, reason: 'message blocked by moderation' } : { ok: true };
}

/** Async classifier port: real adapter = Perspective API / an LLM moderation endpoint; default = heuristic scorer. */
export abstract class ToxicityClassifier {
  abstract score(text: string): Promise<number>;
}

export class HeuristicToxicityClassifier extends ToxicityClassifier {
  async score(text: string): Promise<number> {
    const shouting = text.length > 12 && text === text.toUpperCase() && /[A-Z]/.test(text) ? 0.3 : 0;
    const repeated = /(.)\1{6,}/.test(text) ? 0.3 : 0;
    const insults = /\b(idiot|stupid|trash|loser)\b/i.test(text) ? 0.6 : 0;
    return Math.min(1, shouting + repeated + insults);
  }
}
