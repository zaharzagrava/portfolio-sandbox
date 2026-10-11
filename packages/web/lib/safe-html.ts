import DOMPurify, { type Config } from 'dompurify';

/**
 * The only way a discussion `bodyHtml` reaches the DOM (W02 AS-47, FR-084). An allow-list sanitiser that runs in the
 * browser, so it is imported by client components only (the discussions render after hydration).
 *
 * Tags: p br strong em del code pre blockquote ul ol li a. Attributes: `href`, `rel`, `target` on `a`. Schemes: https,
 * http, mailto; a link with any other scheme becomes its text. Headings of every level are shown as bold paragraphs so
 * the page's heading outline stays intact. Every link gets `rel="nofollow ugc noopener noreferrer"` and
 * `target="_blank"`.
 */

const LINK_REL = 'nofollow ugc noopener noreferrer';
const HEADINGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
const ALLOWED_HREF = /^(?:https?:|mailto:)/i;

const FIRST_PASS: Config = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  ALLOWED_ATTR: ['href'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: ALLOWED_HREF,
  RETURN_DOM_FRAGMENT: true,
};

const SECOND_PASS: Config = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a'],
  ALLOWED_ATTR: ['href', 'rel', 'target'],
  // Without this the scheme regexp below is also applied to the `rel` and `target` values and removes them.
  ADD_URI_SAFE_ATTR: ['rel', 'target'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: ALLOWED_HREF,
};

export function sanitizeBodyHtml(html: string): string {
  if (typeof html !== 'string' || html === '' || typeof window === 'undefined' || !DOMPurify.isSupported) return '';
  const fragment = DOMPurify.sanitize(html, FIRST_PASS) as unknown as DocumentFragment;

  for (const heading of Array.from(fragment.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    if (!HEADINGS.includes(heading.tagName)) continue;
    const paragraph = document.createElement('p');
    const strong = document.createElement('strong');
    while (heading.firstChild) strong.appendChild(heading.firstChild);
    paragraph.appendChild(strong);
    heading.replaceWith(paragraph);
  }

  for (const link of Array.from(fragment.querySelectorAll('a'))) {
    const href = link.getAttribute('href');
    if (!href || !ALLOWED_HREF.test(href.trim())) {
      link.replaceWith(...Array.from(link.childNodes));
      continue;
    }
    for (const name of link.getAttributeNames()) if (name !== 'href') link.removeAttribute(name);
    link.setAttribute('rel', LINK_REL);
    link.setAttribute('target', '_blank');
  }

  const holder = document.createElement('div');
  holder.appendChild(fragment);
  // A second pass over the result keeps the output inside the allow-list whatever the first pass left behind.
  return DOMPurify.sanitize(holder.innerHTML, SECOND_PASS) as unknown as string;
}
