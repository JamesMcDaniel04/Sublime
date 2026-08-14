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
  ...compat.extends("next/core-web-vitals", "next/typescript", "plugin:jsx-a11y/recommended"),
  {
    // Tell jsx-a11y what the design-system wrappers actually render. Without
    // this the rules cannot see through <Input> to the native <input>, and
    // report every correctly-labelled field in the codebase as unlabelled —
    // 116 false positives that would have taught everyone to ignore the rule.
    settings: {
      "jsx-a11y": {
        components: {
          Input: "input",
          Textarea: "textarea",
          Label: "label",
          Button: "button",
          Select: "select",
          Switch: "input",
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "prefer-const": "warn",
      "react/no-unescaped-entities": "off",
      "@next/next/no-img-element": "warn",
      "@next/next/no-html-link-for-pages": "warn",
      // label-has-associated-control resolves CONTROLS from its own option
      // rather than the shared `components` setting above, so the wrappers have
      // to be named here too. depth 3 covers <label><span>Name</span><Input/></label>,
      // the implicit-association pattern used throughout this codebase.
      "jsx-a11y/label-has-associated-control": ["warn", {
        controlComponents: ["Input", "Textarea", "Select", "Switch", "SelectTrigger"],
        depth: 3
      }],
      // ── Accessibility backlog, ratcheted ────────────────────────────────
      // Everything else in jsx-a11y/recommended stays an ERROR. These four
      // carry a known backlog (92 findings as of 2026-08-14, down from 169)
      // that needs per-site judgement rather than a codemod:
      //
      //   label-has-associated-control  multi-line labels and controls that
      //                                 already own an id
      //   click-events-have-key-events  } mostly modal backdrops and
      //   no-static-element-interactions } stopPropagation wrappers
      //   no-autofocus                  legitimate in dialogs, arguable
      //                                 elsewhere (WCAG 3.2.1)
      //
      // They are WARN so the list stays visible, and `npm run lint` passes
      // --max-warnings at exactly today's count — so a NEW violation fails CI
      // while the existing ones are worked down. Lower the number as they go;
      // it can only ratchet down. See docs/accessibility.md.
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/no-autofocus": "warn"
    }
  }
];

export default eslintConfig;
