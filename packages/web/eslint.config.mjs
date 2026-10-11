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
