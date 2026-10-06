import { createHash } from 'node:crypto';

/**
 * SimHash (Charikar): similar documents → hashes a few bits apart. Each
 * 3-word shingle votes on 64 bit positions; the sign of each total is the bit.
 * A product page whose only change is a rotating "people also bought" widget
 * stays within ~3 bits, so we skip re-extracting it.
 */
export function simhash(text: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const votes = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < Math.max(words.length, 3); i++) {
    const shingle = words.slice(i, i + 3).join(' ');
    const h = createHash('md5').update(shingle).digest().readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit++) votes[bit] += (h >> BigInt(bit)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) if (votes[bit] > 0) out |= 1n << BigInt(bit);
  return out.toString(16).padStart(16, '0');
}

export function simhashDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Visible text only: scripts/styles/tags dropped, entities left as-is (good enough for change detection). */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
