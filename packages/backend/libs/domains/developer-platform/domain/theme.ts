export const THEME_FONT_FAMILIES = ['system', 'serif', 'mono'] as const;

export type WidgetThemeValues = Partial<{
  primaryColor: string;
  textColor: string;
  backgroundColor: string;
  borderRadius: string;
  fontFamily: (typeof THEME_FONT_FAMILIES)[number];
  buttonLabel: string;
}>;

export type ThemeResult =
  { ok: true; theme: WidgetThemeValues } | { ok: false; key: string };

const COLOUR = /^#[0-9a-fA-F]{6}$/;
const RADIUS = /^(?:[0-9]|1[0-9]|2[0-4])px$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what a label must not contain
const LABEL = /^[^<>\u0000-\u001f\u007f]{1,40}$/;

const VALUE_RULES: Record<string, (value: string) => boolean> = {
  primaryColor: (v) => COLOUR.test(v),
  textColor: (v) => COLOUR.test(v),
  backgroundColor: (v) => COLOUR.test(v),
  borderRadius: (v) => RADIUS.test(v),
  fontFamily: (v) => (THEME_FONT_FAMILIES as readonly string[]).includes(v),
  buttonLabel: (v) => LABEL.test(v),
};

/**
 * The theme allowlist (FR-007, AS-04): only these keys, only these value formats. A theme value is rendered into someone
 * else's page, so anything else is refused; the loader applies the same rules again and the contract package states them
 * as a schema (`widgetThemeSchema`, compared with this rule in the contract e2e). On failure only the key is named.
 */
export function validateTheme(input: unknown): ThemeResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { ok: false, key: 'theme' };
  for (const [key, value] of Object.entries(input)) {
    const rule = VALUE_RULES[key];
    if (!rule || typeof value !== 'string' || !rule(value))
      return { ok: false, key };
  }
  return { ok: true, theme: input as WidgetThemeValues };
}
