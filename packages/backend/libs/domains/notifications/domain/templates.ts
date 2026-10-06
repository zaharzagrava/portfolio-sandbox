import { NotificationType, Template, typeDef } from './catalog';

export interface Rendered {
  title: string;
  body: string;
  emailSubject: string;
  emailHtml: string;
  link: string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/**
 * `{{var}}` interpolation. Deliberately logic-less (no helpers, no partials):
 * templates are data, so translators can edit them safely. Values are
 * HTML-escaped in HTML templates (a product titled `<script>` stays text), and
 * a missing variable THROWS - a half-rendered "Hi {{name}}" email is a bug to
 * catch in the spec, not something to send to a million users.
 */
export function interpolate(template: string, data: Record<string, string>, html = false): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in data)) throw new Error(`template variable "${key}" missing`);
    return html ? escapeHtml(data[key]) : data[key];
  });
}

/** Locale fallback: exact ("uk-UA") → language ("uk") → "en". */
export function pickTemplate(type: NotificationType, locale: string): Template {
  const { templates } = typeDef(type);
  const all = templates as Record<string, Template | undefined>;
  return all[locale] ?? all[locale.split('-')[0]] ?? templates.en;
}

export function render(type: NotificationType, locale: string, data: Record<string, string>, frontHost: string): Rendered {
  const template = pickTemplate(type, locale);
  const link = typeDef(type).link(data);
  const withUrl = { ...data, url: `${frontHost}${link}` };
  const title = interpolate(template.title, withUrl);
  const body = interpolate(template.body, withUrl);
  return {
    title,
    body,
    link,
    emailSubject: template.emailSubject ? interpolate(template.emailSubject, withUrl) : title,
    emailHtml: template.emailHtml ? interpolate(template.emailHtml, withUrl, true) : `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(withUrl.url)}">Open</a></p>`,
  };
}

/** Minor units → "€12.34" in the user's locale. */
export function formatMoney(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);
}
