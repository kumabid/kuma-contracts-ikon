// @ts-check
const { FlatCompat } = require('@eslint/eslintrc');
const eslint = require('@eslint/js');
const tsimport = require('eslint-plugin-ts-import');
const globals = require('globals');
const tseslint = require('typescript-eslint');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: undefined,
  allConfig: undefined,
});

const config = tseslint.config(
  {
    // config with just ignores is the replacement for `.eslintignore`
    ignores: [
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      '**/data/**',
      '**/.vendor-disabled/**',
      '**/.template/**',
      '**/.idea/**',
      '.DS_Store',
      '.eslintcache',
      '.wip',
      '.artifacts',
      'src/tests/.acceptance/**',
      'src/tests/quick.ts',
    ],
  },

  eslint.configs.recommended,
  ...compat.extends('eslint-config-airbnb-base', 'plugin:import/typescript'),
  {
    files: [
      'src/services/admin-dashboard/**/*.tsx',
      'src/services/admin-dashboard/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: './src/services/admin-dashboard',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals['shared-node-browser'],
      },
    },
    extends: [
      ...compat.extends('eslint-config-airbnb', 'eslint-config-airbnb/hooks'),
    ],
    rules: {
      'jsx-a11y/control-has-associated-label': 'off',
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/label-has-associated-control': 'off',
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    files: ['**/*.ts', '**/*.tsx', '**/*.cjs', '**/*.js'],
    extends: [...tseslint.configs.recommended],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'ts-import': tsimport,
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
      },
    },
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import/resolver': {
        typescript: {
          project: [
            './src/services/*/tsconfig.json',
            './src/packages/*/tsconfig.json',
            './src/core/tsconfig.json',
            './src/config/tsconfig.json',
          ],
        },
      },
    },
    rules: {
      camelcase: 'off',
      'default-param-last': 'off',
      'no-console': 'off',
      // TODO_IKON we should prob have this error
      //           as in most cases it is fixable
      'import/no-cycle': 'warn',
      'no-await-in-loop': 'off',
      // void is used when we enable type checked linting
      // to handle promise dangle / return linting
      'no-void': 'off',
      'no-nested-ternary': 'off',
      'no-multi-assign': 'off',
      'no-restricted-exports': 'off',
      'no-restricted-syntax': 'off',
      'no-shadow': 'off',
      'no-underscore-dangle': 'off',
      'no-use-before-define': 'off',
      'no-empty-function': 'off',
      'no-useless-constructor': 'off',
      'class-methods-use-this': 'off',
      'consistent-return': 'off',
      // prefers => value over => { return value }
      'arrow-body-style': 'off',
      'prefer-arrow-callback': 'off',
      // 'no-only-tests/no-only-tests': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/default-param-last': 'error',
      // TODO_IKON at some point we should turn these on
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      //
      '@typescript-eslint/ban-types': [
        'error',
        {
          types: {
            // `{} & Type` is more usable version of NonNullable<Type>
            '{}': false,
          },
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
        },
      ],
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-shadow': 'error',
      'import/prefer-default-export': 'off',
      'import/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: [
            'dev/**',
            'src/tests/**/*',
            './register.js',
            'src/packages/cli/**/*',
            'eslint.config.cjs',
            'register.cjs',
            '.prettierc.cjs',
          ],
        },
      ],
      'import/extensions': [
        'error',
        'ignorePackages',
        {
          js: 'never',
          jsx: 'never',
          ts: 'never',
          tsx: 'never',
          mjs: 'never',
          cjs: 'always',
        },
      ],
      'import/order': [
        'error',
        {
          // warnOnUnassignedImports: true,
          'newlines-between': 'always',
          groups: [
            'unknown',
            'builtin',
            'external',

            'internal',

            'parent',
            'sibling',
            'index',

            'object',

            'type',
          ],
          pathGroupsExcludedImportTypes: ['type'],
          alphabetize: {
            order:
              'asc' /* sort in ascending order. Options: ['ignore', 'asc', 'desc'] */,
            caseInsensitive: true /* ignore case. Options: [true, false] */,
          },
          pathGroups: [
            {
              pattern: '@kumabid/**',
              group: 'internal',
              position: 'before',
            },
            {
              pattern: '{config,config/**}',
              group: 'internal',
              position: 'before',
            },
            {
              pattern: 'core/{models/**,db,db/**}',
              group: 'internal',
              position: 'before',
            },
            {
              pattern: 'core/**',
              group: 'internal',
              position: 'before',
            },
            {
              pattern: 'packages/**',
              group: 'internal',
              position: 'before',
            },
            {
              pattern: 'services/**',
              group: 'internal',
              position: 'before',
            },
          ],
        },
      ],
      'ts-import/patterns': [
        'error',
        // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
        // !!! Do not relax these rules !!!
        // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
        {
          target: '**/src/services/*/**',
          modules: true,
          allowed: [
            'config',
            'core/**',
            'packages/**',
            // run target.replace(arr[0], arr[1]) to build pattern
            [/.*\/src\/services\/([^/]*)\/.*/, '**/services/$1/**'],
          ],
          message:
            'Services may only import from themselves, the core library, config, or node_modules',
        },
        {
          target: '**/src/packages/*/**',
          modules: true,
          allowed: ['config', 'core/**', '@*/**', 'packages/**', './**'],
          // TODO: Ideally we would not allow importing of core and only allow other packages
          message: 'Packages may only import config, core, or other packages',
        },
        {
          target: '**/src/core/**',
          modules: true,
          allowed: [
            'config',
            'core/**',
            'packages/**',
            // this would allow ../ within core but we should probably
            // promote just using from 'core/...'
            // [/(.*\/src\/core).*/, '$1/**'],
            './**',
          ],
          message:
            'Core packages may only import other core modules or the config',
        },
      ],
    },
  },
  {
    files: ['**/*.cjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },

  {
    files: ['src/tests/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
    rules: {
      // 'no-only-tests/no-only-tests': 'error',
      'func-names': 'off',
      'no-unused-expressions': 'off',
      'no-await-in-loop': 'off',
      'prefer-destructuring': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  ...compat.extends('eslint-config-prettier'),
);

module.exports = config;
