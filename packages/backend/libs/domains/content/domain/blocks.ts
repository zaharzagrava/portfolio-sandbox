import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import { LIMITS } from './limits';

const RICH_TEXT: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'a',
    'ul',
    'ol',
    'li',
    'h2',
    'h3',
    'blockquote',
  ],
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['https'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener' },
    }),
  },
};

/**
 * Sanitises rich text against a fixed allowlist (S27 FR-005): `<script>` and its content, `javascript:` and `data:`
 * links, `on*` and `style` attributes, iframes and images are gone; every remaining link carries `rel="noopener"`.
 * Idempotent: the result of sanitising its own output is itself (the loop settles the rare input whose first pass
 * produces markup the sanitiser would change again).
 */
export function sanitizeRichText(html: string): string {
  let current = sanitizeHtml(html, RICH_TEXT);
  for (let pass = 0; pass < 4; pass++) {
    const next = sanitizeHtml(current, RICH_TEXT);
    if (next === current) break;
    current = next;
  }
  return current;
}

const httpsUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}, 'https only');

const VIDEO_HOSTS = ['www.youtube.com', 'player.vimeo.com'];
export const STREAM_HOST = 'stream.marketplace.dev';
/** S30: the public master playlist; an unlisted video (`/u/…`, signed) is never stored in a block. */
const PUBLIC_PLAYLIST = /^\/p\/[A-Za-z0-9_-]{1,64}\/master\.m3u8$/;

/**
 * A video URL is accepted when its parsed host is exactly one of the allowlist (no suffix, userinfo or port tricks).
 * On the stream host only a public playlist without query, fragment or credential is accepted (S30 follow-up).
 */
export function isAllowedVideoUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '' || url.port !== '')
    return false;
  if (VIDEO_HOSTS.includes(url.hostname)) return true;
  if (url.hostname !== STREAM_HOST) return false;
  return (
    PUBLIC_PLAYLIST.test(url.pathname) && url.search === '' && url.hash === ''
  );
}

const text = (max: number) => z.string().max(max);

/** Typed content blocks (validated on save). Unknown properties are refused. */
export const Block = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3)]),
      text: text(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('richText'),
      html: text(LIMITS.maxRichTextLength).transform(sanitizeRichText),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      url: httpsUrl,
      alt: z.string().min(1).max(300),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ type: z.literal('product'), productId: z.string().uuid() })
    .strict(),
  z
    .object({
      type: z.literal('quote'),
      text: text(500),
      cite: text(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('video'),
      url: z.string().refine(isAllowedVideoUrl, 'unsupported video url'),
    })
    .strict(),
]);
export type Block = z.infer<typeof Block>;

export const Seo = z
  .object({
    description: text(300).optional(),
    ogImage: httpsUrl.optional(),
  })
  .strict();
export type Seo = z.infer<typeof Seo>;

export interface BlockIssue {
  path: string;
  code: string;
}
export type Parsed<T> =
  { ok: true; value: T } | { ok: false; issues: BlockIssue[] };

const MAX_ISSUES = 10;

function issuesOf(error: z.ZodError): BlockIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
  }));
}

/** At most `maxBlocks` blocks; issues carry a path and a code, never the submitted value. */
export function parseBlocks(input: unknown, maxBlocks = 200): Parsed<Block[]> {
  const parsed = z.array(Block).max(maxBlocks).safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: issuesOf(parsed.error) };
}

export function parseSeo(input: unknown): Parsed<Seo> {
  const parsed = Seo.safeParse(input ?? {});
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: issuesOf(parsed.error) };
}
