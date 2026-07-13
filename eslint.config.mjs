// Configuration ESLint (flat config). Deux environnements distincts :
//   - scripts/  : Node.js, modules ES, exécuté en CI (globals Node).
//   - docs/     : navigateur, script classique chargé via <script> (globals
//                 navigateur). data.json est généré, donc ignoré.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "docs/data.json"] },

  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Les catch vides volontaires (JSON illisible, fichier absent) sont
      // commentés et intentionnels.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  {
    files: ["docs/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
];
