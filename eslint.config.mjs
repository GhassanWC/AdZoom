import next from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Flat config (ESLint 9). `next lint` was removed in Next 16, so CI invokes the
 * eslint CLI directly via `npm run lint`.
 *
 * NOTE: this config was added long after the codebase existed, so there is a
 * backlog of pre-existing violations. CI runs `lint` in warn-only mode
 * (continue-on-error) until that backlog is cleared — see
 * .github/workflows/ci.yml. Flip that job to blocking once `npm run lint`
 * is clean; nothing else needs to change.
 */
export default [
  {
    // Build output, vendored code, and the separately-linted service packages.
    ignores: [
      ".next/**",
      "node_modules/**",
      "legacy/**",
      "public/**",
      "services/**",
      "next-env.d.ts",
      "**/*.tsbuildinfo",
    ],
  },
  ...next,
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Unused vars are worth surfacing, but an `_`-prefix escape hatch keeps
      // intentionally-ignored destructured fields and callback args quiet.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Test files and build scripts are Node-side and intentionally loose:
    // stubs and fixtures use `any` freely to stand in for browser/canvas APIs.
    files: ["tests/**", "scripts/**", "*.config.*", "playwright.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
