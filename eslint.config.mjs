import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    // TypeScript itself validates identifiers; no-undef false-positives on
    // DOM and Node globals in .ts/.vue files.
    files: ['**/*.ts', '**/*.vue', '**/*.mts'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // The renderer must reach the main process through src/renderer/ipc.ts, never
    // window.switchboard.invoke directly. contextBridge structured-clones each
    // argument on the way out and rejects a Proxy, so a request built from Vue
    // reactive state fails with "An object could not be cloned" — an error that
    // names neither the field nor the call. ipc.ts strips the proxies first.
    // Everything else on the bridge (on, onLoading, pathForFile) sends no payload
    // outward and is fine to call directly.
    files: ['src/renderer/**/*.{ts,vue}'],
    ignores: ['src/renderer/ipc.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.object.name='window'][object.property.name='switchboard'][property.name='invoke']",
          message:
            "Import { invoke } from '@renderer/ipc' instead. Calling window.switchboard.invoke directly sends Vue reactive proxies across contextBridge, which fails with 'An object could not be cloned'.",
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  prettier,
)
