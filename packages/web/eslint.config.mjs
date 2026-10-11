import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Constitution VII.1: network calls live in lib/api/** and the server-only readers in lib/server/** (W02 A8); route
  // handlers under app/api are the same-origin edge (tests and tooling are exempt).
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    ignores: ["lib/api/**", "lib/server/**", "app/api/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Call the backend through lib/api/* (or lib/server/* on the server)." },
        { name: "EventSource", message: "Streams are opened in lib/api/*." },
      ],
      "no-restricted-imports": ["error", { paths: [{ name: "axios", message: "Call the backend through lib/api/*." }] }],
    },
  },
  // W02 (AS-70, AS-72): no NEXT_PUBLIC API base URL, and HTML is injected only from the sanitizer and the JSON-LD component.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    // components/product/product-discussions.tsx is the old discussions block that T087 deletes.
    ignores: ["**/*.test.{ts,tsx}", "components/seo/json-ld.tsx", "components/product/discussions/safe-body.tsx", "components/product/product-discussions.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Render text; HTML only through sanitizeBodyHtml or the JSON-LD component (VI.7)." },
        { selector: "MemberExpression[property.name='NEXT_PUBLIC_API_URL']", message: "The browser calls relative same-origin URLs (AS-70)." },
      ],
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
        { selector: "MemberExpression[property.name='NEXT_PUBLIC_API_URL']", message: "The browser calls relative same-origin URLs (AS-70)." },
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
        { name: "EventSource", message: "Streams are opened in lib/api/*." },
        { name: "localStorage", message: "No credential or session state in web storage (VI.2)." },
        { name: "sessionStorage", message: "No credential or session state in web storage (VI.2)." },
      ],
    },
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
