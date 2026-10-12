// Lint config. Deliberately catches real mistakes (undefined names, unreachable code, duplicate keys)
// rather than style, so it can gate CI without a mass reformat of existing code.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'internal/**', 'test-results/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        NXTK: 'writable',
        NexusExt: 'writable',
        DOWNLOAD_PARSER: 'readonly',
        module: 'readonly',
        importScripts: 'readonly'
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off',
      'no-redeclare': ['error', { builtinGlobals: false }]
    }
  },
  {
    files: ['tools/**/*.{js,cjs,mjs}', 'tests/**/*.mjs', '*.config.mjs'],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.node, NexusExt: 'writable', NXTK: 'writable', document: 'readonly' } },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': 'off', 'no-empty': 'off' }
  },
  {
    files: ['relay/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.serviceworker } },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': 'off', 'no-empty': ['error', { allowEmptyCatch: true }] }
  },
  { files: ['tools/**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  { files: ['tools/**/*.mjs', 'tests/**/*.mjs', '*.config.mjs'], languageOptions: { sourceType: 'module' } }
];
