import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import eslintConfigPrettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "migrations/**",
      // TODO(FND-07): remove once server/index.js (Express) is replaced by
      // Next.js Route Handlers; kept temporarily so lint stays actionable
      // during the migration instead of failing on code slated for deletion.
      "server/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // A structured logger (lib/logger.ts) is the only sanctioned way to
      // write to stdout/stderr from application code; scripts get an
      // override below since they are small CLIs printed for humans.
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: [
      "tests/**/*.ts",
      "tests/**/*.tsx",
      "**/*.test.ts",
      "**/*.test.tsx",
      "playwright.config.ts",
    ],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  eslintConfigPrettier,
];

export default config;
