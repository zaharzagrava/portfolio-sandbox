import { NotificationType, Template, typeDef } from './catalog';
import { UK_TEMPLATES } from './catalog-uk';
import { formatMoney } from './money';

/** Inbox title and body limits (AS-66); a push body is shorter still, so the OS never truncates mid-word. */
export const TITLE_MAX = 120;
export const BODY_MAX = 500;
export const PUSH_BODY_MAX = 240;
/** A subject is one line of a mail header. */
export const SUBJECT_MAX = 200;

export interface Rendered {
  /** ≤ TITLE_MAX. */
  title: string;
  /** ≤ BODY_MAX. */
  body: string;
  /** ≤ PUSH_BODY_MAX. */
  pushBody: string;
  /** One line, no CR or LF (header injection), ≤ SUBJECT_MAX. */
  emailSubject: string;
  emailHtml: string;
  /** An application-relative path built by the catalog from validated identifiers. */
  link: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Cuts `text` to `max` characters, the last one an ellipsis. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * `{{var}}` interpolation. Deliberately logic-less (no helpers, no partials):
 * templates are data, so translators can edit them safely. Values are
 * HTML-escaped in HTML templates (a product titled `<script>` stays text), and
 * a missing variable THROWS - a half-rendered "Hi {{name}}" email is a bug to
 * catch in the spec, not something to send to a million users. Replacement is a
 * single pass: a value that looks like a placeholder is not expanded again.
 */
export function interpolate(
  template: string,
  data: Record<string, string>,
  html = false,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in data)) throw new Error(`template variable "${key}" missing`);
    return html ? escapeHtml(data[key]) : data[key];
  });
}

const TEMPLATES_BY_LANGUAGE: Record<
  string,
  Partial<Record<NotificationType, Template>>
> = { uk: UK_TEMPLATES };

/** Exact locale ("uk-UA"), then its language ("uk"), then English. */
const localeChain = (locale: string): string[] => {
  const lower = locale.toLowerCase();
  return [lower, lower.split('-')[0], 'en'];
};

/**
 * Locale fallback: exact ("uk-UA") → language ("uk") → "en". A `variant` (see `NotificationTypeDef.variant`) selects
 * a whole alternative template, in the same fallback order; an unknown variant falls back to the base template.
 */
export function pickTemplate(
  type: NotificationType,
  locale: string,
  variant: string | null = null,
): Template {
  const def = typeDef(type);
  const chain = localeChain(locale);
  const variants = variant ? def.variants?.[variant] : undefined;
  if (variants)
    for (const language of chain) {
      const found = (variants as Record<string, Template | undefined>)[
        language
      ];
      if (found) return found;
    }
  for (const language of chain) {
    const found =
      language === 'en'
        ? def.templates.en
        : TEMPLATES_BY_LANGUAGE[language]?.[type];
    if (found) return found;
  }
  return def.templates.en;
}

/**
 * Money arrives as integer minor units next to a `currency` code (`totalMinor: "129900"`, `currency: "USD"`); every
 * `<name>Minor` becomes `<name>` formatted for the recipient's locale. A malformed amount or currency makes the render
 * fail (`render_failed`), never a half-formatted message.
 */
export function withMoney(
  data: Record<string, string>,
  locale: string,
): Record<string, string> {
  const currency = data.currency;
  if (!currency) return data;
  const out = { ...data };
  for (const [key, value] of Object.entries(data)) {
    const name = /^(\w+)Minor$/.exec(key)?.[1];
    if (!name) continue;
    out[name] = formatMoney(value, currency, locale);
  }
  return out;
}

/** Identifiers that may appear in a link: UUIDs, slugs and opaque URL-safe tokens. Nothing with `/`, `.`, `:`, `?`, `#`. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * The data a catalog link function sees: reading a field that is missing or is not a safe identifier throws, so a link
 * is only ever the catalog's own path template filled with validated identifiers (never a URL or a `../` from an event).
 */
function linkData(data: Record<string, string>): Record<string, string> {
  return new Proxy(data, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      const value = target[key];
      if (value === undefined)
        throw new Error(`link variable "${key}" missing`);
      if (!SAFE_IDENTIFIER.test(value))
        throw new Error(`link variable "${key}" is not a safe identifier`);
      return value;
    },
  });
}

export function render(
  type: NotificationType,
  locale: string,
  rawData: Record<string, string>,
  frontHost: string,
): Rendered {
  const def = typeDef(type);
  const data = withMoney(rawData, locale);
  const template = pickTemplate(type, locale, def.variant?.(data) ?? null);
  const link = def.link(linkData(data));
  const withUrl = { ...data, url: `${frontHost}${link}` };
  const title = interpolate(template.title, withUrl);
  const body = interpolate(template.body, withUrl);
  const subject = template.emailSubject
    ? interpolate(template.emailSubject, withUrl)
    : title;
  return {
    title: clip(title, TITLE_MAX),
    body: clip(body, BODY_MAX),
    pushBody: clip(body, PUSH_BODY_MAX),
    link,
    emailSubject: clip(subject.replace(/[\r\n]+/g, ' ').trim(), SUBJECT_MAX),
    emailHtml: template.emailHtml
      ? interpolate(template.emailHtml, withUrl, true)
      : `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(withUrl.url)}">Open</a></p>`,
  };
}
