import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    // .claude/** holds agent worktrees — full copies of this repo. Linting
    // them reported the whole codebase several hundred times over (~107k
    // problems, 2.6k of them errors), so `npm run lint` exited 1 on any
    // machine that had one, and genuine errors in src were invisible in the
    // noise. They are excluded from git via .git/info/exclude; this is the
    // same exclusion for the linter.
    ignores: ["next-env.d.ts", ".next/**", ".claude/**"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "prefer-const": "warn",
      "react/no-unescaped-entities": "off",
      "@next/next/no-img-element": "warn",
      "@next/next/no-html-link-for-pages": "warn"
    }
  }
];

export default eslintConfig;
