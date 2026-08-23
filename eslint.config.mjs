/* UNDEFINED-IDENTIFIER GUARD — wired into `npm run build`, not optional.
 *
 * WHY THIS IS IN THE BUILD PATH. Three separate undefined-identifier bugs shipped to production in
 * one working session, and every one of them passed `npm run build`:
 *
 *   api/pulse.js   `scoped` and `LEADERSHIP_ROLES` — 500s on a live endpoint
 *   src/Notifications.jsx  `ClipboardList` in a module-level const — the ENTIRE APP rendered blank
 *                          for every user, and three further commits shipped on top of it
 *
 * They all pass because neither tool in the path does scope analysis: `node --check` parses syntax
 * only, and esbuild/Vite treat an unknown identifier as a global to be resolved at runtime. The
 * failure therefore appears at RENDER — which for a module-level reference means at import, which
 * means a white screen with no other symptom.
 *
 * A lint script nobody is obliged to run would not have caught any of these; I had one for api/ and
 * the next bug landed in src/. So this runs as the first half of `build`, and a build with an
 * undefined identifier FAILS instead of shipping. A failed build is safe — the previous deployment
 * keeps serving.
 *
 * DELIBERATELY ONE RULE. This is a correctness guard, not a style regime: adding formatting rules
 * to a 14k-line file nobody has linted before would produce thousands of errors and the whole thing
 * would be switched off within a day.
 */
import globals from "globals";

/* The codebase carries `eslint-disable-next-line react-hooks/exhaustive-deps` comments from before
   any linting existed. ESLint errors on a disable directive naming a rule it does not have, so those
   comments would fail every build. Installing the real plugin instead would surface hundreds of
   pre-existing hook findings in a 14k-line file — and a guard that shouts on day one gets switched
   off by day two. These stubs let the existing comments resolve to a rule that never reports, so the
   one rule we actually care about is the only thing that can fail a build. */
const noop = { create: () => ({}) };
const reactHooksStub = { rules: { "exhaustive-deps": noop, "rules-of-hooks": noop } };

export default [
  { ignores: ["dist/**", "node_modules/**", "android/**", "ios/**", "_report_preview/**", "_digest_preview/**"] },

  // Client — browser globals, JSX, plus __BUILD_ID__ injected by vite's `define`.
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, __BUILD_ID__: "readonly" },
    },
    plugins: { "react-hooks": reactHooksStub },
    // The stubs never report, so every existing directive reads as "unused". Silenced rather than
    // stripped: those comments document a real deliberate choice at each call site, and deleting
    // them would lose that and make the code lie if the plugin is ever added for real.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "no-undef": "error" },
  },

  // Serverless functions and scripts — node globals, and fetch/Buffer from the modern runtime.
  {
    files: ["api/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { "no-undef": "error" },
  },

  // shared/ is imported by BOTH, so it may rely on neither environment's extras — only the
  // language's own built-ins plus Intl. Keeping its globals narrow is what stops something
  // browser-only (or node-only) drifting into a module the other side has to run.
  {
    files: ["shared/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { Intl: "readonly", console: "readonly", process: "readonly" },
    },
    rules: { "no-undef": "error" },
  },
];
