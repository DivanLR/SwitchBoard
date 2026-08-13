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
    // Transport belongs to the stores. Components and views render store state
    // and call store actions; a component that invokes an IPC method itself owns
    // a slice of server state nothing else can see or reuse, and it is where
    // unguarded request races keep appearing. `errorMessage` is a formatter, not
    // transport, so it stays importable anywhere.
    //
    // The rule above bans the raw bridge; this one bans the wrapper, which is
    // how a direct call got back into SettingsPanel unnoticed.
    files: ['src/renderer/**/*.{ts,vue}'],
    ignores: ['src/renderer/stores/**', 'src/renderer/ipc.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@renderer/ipc',
              importNames: ['invoke'],
              message:
                'Call the main process from a store action, not from a component. Add an action to the store that owns this data and call that instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // The Agent SDK belongs to src/main/sessions/ and nowhere else (CLAUDE.md).
    // Stated as a rule for a while but never enforced, and it had already drifted:
    // permission-broker.ts imported a type straight from the package. Type-only
    // still counts — it couples that file to the SDK's shape, so an upgrade that
    // reshapes it stops being a change confined to one directory. Anything else
    // that genuinely needs an SDK type re-exports it from sessions/, as session.ts
    // does for PermissionResult.
    files: ['src/main/**/*.ts', 'src/shared/**/*.ts', 'src/renderer/**/*.{ts,vue}'],
    ignores: ['src/main/sessions/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/claude-agent-sdk',
              message:
                'Only src/main/sessions/ may import the Agent SDK. Re-export what you need from there (see PermissionResult in sessions/session.ts) and import it from @main/sessions/.',
            },
          ],
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
  {
    // The design lab: a plain Node server plus a browser module, neither of
    // which is part of the app. It runs in both worlds, so it gets both sets of
    // globals rather than the renderer's stricter rules.
    files: ['design-lab/**/*.{mjs,js}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
      },
    },
  },
  prettier,
)
