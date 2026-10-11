import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Constitution VII.1: network calls live in lib/api/** (tests and tooling are exempt).
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    ignores: ["lib/api/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Call the backend through lib/api/*." }],
      "no-restricted-imports": ["error", { paths: [{ name: "axios", message: "Call the backend through lib/api/*." }] }],
    },
  },
  // W01 (VI.2, VI.7): no credential in the browser - no web storage, no Authorization header, no cookie access outside
  // lib/api/csrf.ts - and no HTML injection in the auth and account code.
  {
    files: [
      "app/(auth)/**/*.{ts,tsx}",
      "app/account/**/*.{ts,tsx}",
      "components/auth/**/*.{ts,tsx}",
      "hooks/**/*.{ts,tsx}",
      "lib/api/**/*.{ts,tsx}",
      "lib/auth/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}", "lib/api/csrf.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "No credential or session state in web storage (VI.2)." },
        { name: "sessionStorage", message: "No credential or session state in web storage (VI.2)." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "Identifier[name='Authorization']", message: "The browser never sends Authorization; the BFF attaches identity (VI.2)." },
        { selector: "Property[key.value=/^authorization$/i]", message: "The browser never sends Authorization (VI.2)." },
        { selector: "MemberExpression[object.name='document'][property.name='cookie']", message: "Cookies are read only in lib/api/csrf.ts." },
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Render text only (VI.7)." },
      ],
    },
  },
  {
    files: ["app/(auth)/**/*.{ts,tsx}", "app/account/**/*.{ts,tsx}", "components/auth/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/auth/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Call the backend through lib/api/*." },
        { name: "localStorage", message: "No credential or session state in web storage (VI.2)." },
        { name: "sessionStorage", message: "No credential or session state in web storage (VI.2)." },
      ],
    },
  },
  // Existing violations in pages W07 does not own (W02 moves these calls into lib/api/*); warn until then.
  {
    files: ["app/page.tsx", "app/products/[[]slug]/page.tsx", "app/search/page.tsx"],
    rules: { "no-restricted-globals": ["warn", { name: "fetch", message: "Call the backend through lib/api/* (W02 follow-up)." }] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
