/**
 * Synchronous, microsecond-cheap checks on the comment hot path (FR-020). Anything smarter (toxicity models, LLM review)
 * runs async and removes after the fact (`LiveModerationConsumer`) - a 5k/s chat can't wait on a model per message.
 * Terms match WHOLE words after normalization ("scampi" passes, "scam" and "scams" do not); the list is never revealed.
 */
const BANNED = ['scam', 'fake', 'counterfeit', 'free iphone', 'click here'];
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};
const char = (code: number) => String.fromCharCode(code);
/** Combining marks left by NFKD (accents): U+0300 to U+036F. */
const COMBINING_MARKS = new RegExp(`[${char(0x0300)}-${char(0x036f)}]`, 'g');
/** Zero-width characters, direction marks, the word joiner, the byte order mark and the soft hyphen. */
const INVISIBLE = new RegExp(
  `[${char(0x200b)}-${char(0x200f)}${char(0x2060)}${char(0xfeff)}${char(0x00ad)}]`,
  'g',
);
const BANNED_MATCHERS = BANNED.map(
  (term) => new RegExp(`(?:^| )${term}s?(?: |$)`),
);

export type SyncVerdict =
  { ok: true } | { ok: false; reason: 'link' | 'policy' };

export function normalizeForModeration(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(COMBINING_MARKS, '')
    .replace(INVISIBLE, '')
    .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1') // "scaaaam" → "scam"
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function syncModeration(text: string): SyncVerdict {
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: 'link' };
  const normalized = normalizeForModeration(text);
  // Re-join letter-spaced evasions ("s c a m") without gluing real words together ("fa keyboard" ≠ "fake").
  const rejoined = normalized.replace(/\b(?:\w ){2,}\w\b/g, (run) =>
    run.replace(/ /g, ''),
  );
  const hit = BANNED_MATCHERS.some((matcher) =>
    [normalized, rejoined].some((t) => matcher.test(t)),
  );
  return hit ? { ok: false, reason: 'policy' } : { ok: true };
}
