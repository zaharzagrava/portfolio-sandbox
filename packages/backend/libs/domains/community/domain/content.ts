import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

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
  transformTags: {
    // User links never pass page rank or reach window.opener.
    a: sanitizeHtml.simpleTransform('a', {
      rel: 'nofollow ugc noopener noreferrer',
      target: '_blank',
    }),
  },
} satisfies sanitizeHtml.IOptions;

/**
 * User content → safe HTML ONCE at write time (lesson 05/01 §1): markdown is
 * rendered, then an allowlist sanitizer strips everything else (script,
 * on*-handlers, javascript: URLs, iframes, style). Reads serve stored HTML -
 * no per-view rendering cost; the raw markdown is kept for editing.
 */
export function renderUserMarkdown(markdown: string): string {
  return sanitizeHtml(
    marked.parse(markdown, { async: false, gfm: true, breaks: true }),
    ALLOWED,
  );
}
