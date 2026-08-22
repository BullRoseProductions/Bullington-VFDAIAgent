/* Undefined-identifier check for api/. Run:
 *     npx eslint --no-config-lookup --config eslint.api.config.mjs api/*.js
 *
 * WHY THIS FILE EXISTS. Nothing else in this repo catches a ReferenceError in api/ before it
 * reaches production:
 *   - `node --check` parses syntax only; an undefined identifier is valid syntax.
 *   - `npm run build` is Vite, which never compiles api/ at all.
 *   - `esbuild --bundle` resolves IMPORT PATHS but treats unknown identifiers as globals, so it
 *     reports nothing. (I claimed otherwise in an earlier commit; that was wrong.)
 *   - importing the module proves top-level code runs, but a function body is not evaluated until
 *     it is called — and handlers are only called in production.
 *
 * Two ReferenceErrors reached production during this work, both from edits that deleted a
 * declaration and left its uses behind. Each showed up as a 500 on a live endpoint. This catches
 * that class in about a second.
 *
 * Deliberately NOT named eslint.config.mjs: this is a targeted check, not a house style, and it
 * should not start governing src/ by accident.
 */
export default [{
  files: ["**/*.js"],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    globals: {
      console: "readonly", process: "readonly", fetch: "readonly",
      URLSearchParams: "readonly", URL: "readonly", Buffer: "readonly",
      Intl: "readonly", TextEncoder: "readonly",
    },
  },
  rules: { "no-undef": "error" },
}];
