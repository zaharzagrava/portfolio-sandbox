import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';

const RICH_TEXT: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote'],
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['https'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener' }) },
};
const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'), 'https only');

/**
 * Typed content blocks (validated on save). Rich text is sanitized at WRITE
 * time with an allowlist (05/01 §1) - pages render stored HTML as-is, so a
 * compromised brand account still can't inject script into the storefront.
 */
export const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), text: z.string().max(200) }),
  z.object({ type: z.literal('richText'), html: z.string().max(20_000).transform((html) => sanitizeHtml(html, RICH_TEXT)) }),
  z.object({ type: z.literal('image'), url: httpsUrl, alt: z.string().min(1).max(300), width: z.number().int().positive(), height: z.number().int().positive() }),
  z.object({ type: z.literal('product'), productId: z.string().uuid() }),
  z.object({ type: z.literal('quote'), text: z.string().max(500), author: z.string().max(100).optional() }),
  z.object({ type: z.literal('video'), url: httpsUrl.refine((u) => /^https:\/\/(www\.youtube\.com|player\.vimeo\.com|stream\.marketplace\.dev)\//.test(u), 'unsupported video host') }),
]);
export const Blocks = z.array(Block).max(200);
export type Block = z.infer<typeof Block>;

export const Seo = z.object({ description: z.string().max(300).optional(), ogImage: httpsUrl.optional() }).default({});

/** Locale fallback chain: "uk-UA" → "uk" → story default. */
export function localeChain(requested: string, available: string[], fallback: string): string | null {
  const lower = requested.toLowerCase();
  const exact = available.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const language = available.find((l) => l.toLowerCase() === lower.split('-')[0]);
  if (language) return language;
  return available.includes(fallback) ? fallback : (available[0] ?? null);
}
