import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/**
 * User content (S25 E1-E5, FR-040 to FR-042). Markdown is rendered, then an allow-list sanitiser strips everything
 * else (script, event handlers, dangerous links, images, embeds, styles). The raw markdown is the stored truth; the
 * rendition carries the policy version that produced it, and a reader re-renders when the stored version is older.
 */

/** Bump when the allow-list or the neutralising rules change: older renditions are re-rendered on read (AS-10). */
export const HTML_POLICY_VERSION = 2;

/** More nested quote and list levels than this are refused (`markdown_too_complex`). */
export const MAX_MARKDOWN_NESTING = 20;

export const TITLE_MIN = 3;
export const TITLE_MAX = 300;
export const POST_BODY_MAX = 40_000;
export const COMMENT_BODY_MAX = 10_000;
export const PREVIEW_LENGTH = 140;

/** U+200B: breaks a pattern in visible text (`javascript:`, `onerror=`) without changing how it reads. */
const NEUTRAL = String.fromCharCode(0x200b);

const codePoints = (text: string): number => [...text].length;

/** Builds a character class from code point ranges (keeps invisible characters out of the source). */
const charClass = (...ranges: Array<[number, number]>): string =>
  ranges
    .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)
    .join('');

/** U+0000-U+001F, U+007F and the bidirectional overrides U+202A-U+202E, U+2066-U+2069. */
const FORBIDDEN_TITLE = new RegExp(
  `[${charClass([0, 0x1f], [0x7f, 0x7f], [0x202a, 0x202e], [0x2066, 0x2069])}]`,
  'u',
);

/** Trimmed title, or `null` when it breaks the rules: 3-300 code points, no control or bidirectional override. */
export function normalizeTitle(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const title = input.trim();
  const length = codePoints(title);
  if (length < TITLE_MIN || length > TITLE_MAX) return null;
  return FORBIDDEN_TITLE.test(title) ? null : title;
}

export class MarkdownTooComplexError extends Error {
  constructor() {
    super('markdown_too_complex');
  }
}

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=\s|$)/;

/** Deepest quote/list nesting of a markdown text, from line prefixes only (no parsing). */
export function markdownNesting(markdown: string): number {
  let deepest = 0;
  let lineStart = 0;
  const n = markdown.length;
  while (lineStart <= n) {
    let end = markdown.indexOf('\n', lineStart);
    if (end === -1) end = n;
    let pos = lineStart;
    let indent = 0;
    while (pos < end && (markdown[pos] === ' ' || markdown[pos] === '\t')) {
      indent += markdown[pos] === '\t' ? 4 : 1;
      pos++;
    }
    let tokens = 0;
    let firstIsList = false;
    while (pos < end) {
      if (markdown[pos] === '>') {
        tokens++;
        pos++;
      } else {
        const marker = LIST_MARKER.exec(markdown.slice(pos, pos + 12));
        if (!marker) break;
        if (tokens === 0) firstIsList = true;
        tokens++;
        pos += marker[0].length;
      }
      while (pos < end && (markdown[pos] === ' ' || markdown[pos] === '\t'))
        pos++;
    }
    const depth = tokens + (firstIsList ? Math.floor(indent / 2) : 0);
    if (depth > deepest) deepest = depth;
    lineStart = end + 1;
  }
  return deepest;
}

/** Refuses a body that nests quotes and lists deeper than `MAX_MARKDOWN_NESTING`, before any parsing. */
export function assertMarkdownComplexity(markdown: string): void {
  if (markdownNesting(markdown) > MAX_MARKDOWN_NESTING)
    throw new MarkdownTooComplexError();
}

const ALLOWED_SCHEMES = /^(?:https?:\/\/|mailto:)/;
const NAUGHTY_ANYWHERE = /(?:javascript|vbscript|data)\s*:/i;

/** Whitespace, control and invisible characters a browser ignores inside a URL scheme. */
const INVISIBLE = new RegExp(
  `[${charClass([0, 0x20], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202f], [0xfeff, 0xfeff])}]`,
  'gu',
);

const toH4 = () => ({ tagName: 'h4', attribs: {} as Record<string, string> });

const ALLOWED = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'del',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
    'h3',
    'h4',
  ],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    h1: toH4,
    h2: toH4,
    h5: toH4,
    h6: toH4,
    // User links never pass page rank or reach window.opener; a link that is not absolute http(s)/mailto, or that
    // mentions a script scheme anywhere, loses its anchor (the text stays).
    a: (_tag: string, attribs: Record<string, string>): sanitizeHtml.Tag => {
      const href = attribs.href ?? '';
      const normalised = href.replace(INVISIBLE, '');
      if (
        !ALLOWED_SCHEMES.test(normalised.toLowerCase()) ||
        NAUGHTY_ANYWHERE.test(normalised)
      )
        return { tagName: 'span', attribs: {} };
      return {
        tagName: 'a',
        attribs: {
          href,
          rel: 'nofollow ugc noopener noreferrer',
          target: '_blank',
        },
      };
    },
  },
  // Visible text that merely reads like a script scheme or an event handler is kept readable but can no longer match.
  textFilter: (text: string) =>
    text
      .replace(/\b(javascript|vbscript|data)(?=\s*:)/gi, `$1${NEUTRAL}`)
      .replace(/\b(on[a-z]+)(?=\s*=)/gi, `$1${NEUTRAL}`)
      .replace(/(\sstyle)(?=\s*=)/gi, `$1${NEUTRAL}`),
} satisfies sanitizeHtml.IOptions;

/** Markdown to safe HTML under the current policy (`HTML_POLICY_VERSION`). The caller runs `assertMarkdownComplexity`. */
export function renderUserMarkdown(markdown: string): string {
  return sanitizeHtml(
    marked.parse(markdown, { async: false, gfm: true, breaks: true }),
    ALLOWED,
  ).trim();
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** First 140 code points of the plain text of a markdown body (no markup, no entities), for event previews. */
export function plainTextPreview(markdown: string): string {
  const text = sanitizeHtml(renderUserMarkdown(markdown), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e])
    .replace(new RegExp(NEUTRAL, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, PREVIEW_LENGTH).join('');
}
