import js from '@eslint/js';
import globals from 'globals';

export default [
  // frontend/ has its own linter (oxlint, see frontend/package.json).
  { ignores: ['node_modules/', 'coverage/', 'frontend/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
];
