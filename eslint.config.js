/** @type {import('eslint').Linter.FlatConfig[]} */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // ── Airbnb core conventions ──
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      'camelcase': ['error', { properties: 'never', ignoreDestructuring: true, ignoreImports: true }],
      'prefer-destructuring': ['warn', { object: true, array: false }],
      'prefer-template': 'warn',
      'prefer-arrow-callback': 'warn',
      'object-shorthand': ['warn', 'always'],
      'no-useless-assignment': 'error',
      'no-unused-expressions': 'error',

      // ── Variable naming ──
      'id-length': ['error', {
        min: 2,
        exceptions: [
          // Loop indices (extremely common in DSP/modem code)
          'i', 'j', 'k',
          // Coordinate math
          'x', 'y', 'z',
          // DSP: tone index, time index, sample counter
          't', 'n', 's',
          // Comparison values, generic accumulators
          'a', 'b', 'c',
          // Index offsets, bit positions
          'o', 'p', 'q',
          // Byte/payload marker, file descriptor
          'r', 'g', 'f',
          // React convention: event
          'e',
          // Generic element refs
          'v', 'w', 'h', 'u', 'd', 'm',
          // Uppercase — algorithm constants, type params
          'N', 'K', 'T', 'C', 'B', 'L', 'M', 'I', 'Q', 'R', 'S', 'P',
          'A', 'D', 'E', 'F', 'G', 'H', 'U', 'V', 'W', 'X', 'Y', 'Z',
        ],
      }],
      // Allow single-letter in destructuring (common: { x, y }, { a, b })
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^.',
      }],

      // ── TypeScript-specific ──
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': ['warn', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      }],
      '@typescript-eslint/no-unused-expressions': 'error',

      // ── Style ──
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
      'indent': ['warn', 2, { SwitchCase: 1 }],
      'comma-dangle': ['warn', 'always-multiline'],
      'arrow-parens': ['warn', 'always'],
      'arrow-body-style': ['warn', 'as-needed'],
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['src/**/*.tsx'],
    rules: {
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
    },
  },
  {
    // Test files — relaxed rules for test DSL
    files: ['src/**/*.test.ts'],
    rules: {
      'id-length': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    // Workers — inline web worker code, relaxed
    files: ['src/workers/*.worker.ts'],
    rules: {
      'id-length': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.*'],
  },
);
