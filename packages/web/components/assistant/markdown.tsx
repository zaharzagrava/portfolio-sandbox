import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The answer as safe Markdown (W05 AS-44, constitution VI.7): paragraphs, emphasis, lists, tables, code and links only. There is
 * no raw-HTML plugin and `skipHtml` drops what the text contains, images and headings are not in the allow-list (their text stays),
 * and only `http`, `https` or a same-site relative path is a link; anything else shows as text.
 */
const ALLOWED = ['p', 'br', 'em', 'strong', 'del', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'pre', 'a', 'blockquote'];

export function safeAnswerUrl(url: string): string | undefined {
  const value = url.trim();
  if (value.startsWith('/')) return value.startsWith('//') || value.includes('\\') ? undefined : value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml allowedElements={ALLOWED} unwrapDisallowed urlTransform={(url) => safeAnswerUrl(url) ?? null} components={components}>
      {children}
    </ReactMarkdown>
  );
}
