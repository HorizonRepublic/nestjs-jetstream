import eslintConfigPrettier from 'eslint-config-prettier';
import preferArrowPlugin from 'eslint-plugin-prefer-arrow';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import unusedImports from 'eslint-plugin-unused-imports';
import jsoncParser from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';

export default [
  eslintConfigPrettier,
  ...tseslint.configs.recommended,

  {
    ...sonarjs.configs.recommended,
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      ...sonarjs.configs.recommended.rules,
      'sonarjs/todo-tag': 'off',
      'sonarjs/no-duplicate-string': 'off',
    },
  },

  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-example/**',
      '**/tmp/**',
      '**/.docusaurus/**',
      '**/.nx/**',
      'jest.config.ts',
    ],
  },

  {
    files: ['apps/**/package.json'],
    languageOptions: {
      parser: jsoncParser,
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    plugins: {
      'prefer-arrow': preferArrowPlugin,
      prettier: eslintPluginPrettier,
      'unused-imports': unusedImports,
    },
    rules: {
      'array-bracket-spacing': ['error', 'never'],
      'arrow-spacing': 'error',
      camelcase: ['error', {ignoreDestructuring: false, properties: 'never'}],
      'comma-dangle': ['error', 'always-multiline'],
      complexity: ['warn', 10],
      'function-call-argument-newline': ['error', 'consistent'],
      'lines-between-class-members': [
        'error',
        {
          enforce: [
            {blankLine: 'always', next: 'method', prev: 'method'},
            {blankLine: 'always', next: 'method', prev: 'field'},
          ],
        },
        {
          exceptAfterSingleLine: true,
        },
      ],
      'max-depth': ['warn', 4],
      'max-params': ['warn', 4],
      'no-alert': 'error',
      'no-console': ['warn', {allow: ['warn', 'error']}],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-multiple-empty-lines': ['error', {max: 1, maxBOF: 0, maxEOF: 1}],
      'no-useless-constructor': 'error',
      'no-useless-return': 'error',
      'no-var': 'error',
      'object-curly-spacing': ['error', 'always'],
      'padding-line-between-statements': [
        'error',
        {blankLine: 'always', next: '*', prev: ['const', 'let', 'var']},
        {blankLine: 'any', next: ['const', 'let', 'var'], prev: ['const', 'let', 'var']},
        {blankLine: 'always', next: '*', prev: 'import'},
        {blankLine: 'any', next: 'import', prev: 'import'},
        {blankLine: 'always', next: 'function', prev: '*'},
        {blankLine: 'always', next: 'class', prev: '*'},
        {blankLine: 'always', next: 'export', prev: '*'},
        {blankLine: 'always', next: '*', prev: 'block-like'},
      ],
      'prefer-arrow-callback': 'error',
      'prefer-arrow/prefer-arrow-functions': [
        'error',
        {
          classPropertiesAllowed: false,
          disallowPrototype: true,
          singleReturnOnly: false,
        },
      ],
      'prefer-const': 'error',
      'prefer-template': 'error',
      'prettier/prettier': ['error'],
      'template-curly-spacing': ['error', 'never'],
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./tsconfig.json', './examples/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/array-type': ['error', {default: 'array'}],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowConciseArrowFunctionExpressionsStartingWithVoid: false,
          allowDirectConstAssertionInArrowFunctions: true,
          allowExpressions: false,
          allowHigherOrderFunctions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit',
          overrides: {
            accessors: 'explicit',
            constructors: 'explicit',
            methods: 'explicit',
            parameterProperties: 'off',
            properties: 'explicit',
          },
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/member-ordering': [
        'error',
        {
          default: [
            'public-static-field',
            'protected-static-field',
            'private-static-field',
            'public-instance-field',
            'protected-instance-field',
            'private-instance-field',
            'public-abstract-field',
            'protected-abstract-field',
            'public-constructor',
            'protected-constructor',
            'private-constructor',
            'public-static-method',
            'protected-static-method',
            'private-static-method',
            'public-instance-method',
            'protected-instance-method',
            'private-instance-method',
            'public-abstract-method',
            'protected-abstract-method',
          ],
        },
      ],
      '@typescript-eslint/method-signature-style': ['error', 'method'],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          filter: {
            match: true,
            regex: '^[A-Z][A-Z0-9_]*(_TOKEN|_KEY|_CONFIG)?$',
          },
          format: ['UPPER_CASE', 'camelCase'],
          modifiers: ['const'],
          selector: 'variable',
        },
        {format: ['camelCase'], selector: 'variableLike'},
        {format: ['camelCase'], selector: 'memberLike'},
        {format: ['PascalCase'], selector: 'typeLike'},
        {format: ['PascalCase'], selector: 'enumMember'},
        {format: ['PascalCase'], prefix: ['I'], selector: 'interface'},
        {format: ['PascalCase'], selector: 'typeAlias'},
      ],
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-useless-empty-export': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      camelcase: 'off',
      'comma-dangle': 'off',
      'no-duplicate-imports': 'off',
      'no-unused-vars': 'off',
      'no-useless-constructor': 'off',
      semi: 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          vars: 'all',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    files: ['jest.config.*'],
    rules: {
      '@typescript-eslint/naming-convention': 'off',
      camelcase: 'off',
    },
  },
];