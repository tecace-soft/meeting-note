module.exports = {
  root: true,
  env: {
    browser: true,
    es2020: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: false,
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'workflow-server/build/',
    'supabase/functions/',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    // Allow intentional infinite loops (e.g. `while (true)` stream readers that
    // break on `done`); still flag constant conditions in if/ternary.
    'no-constant-condition': ['error', { checkLoops: false }],
    'react-refresh/only-export-components': 'off',
  },
  overrides: [
    {
      // The workflow-server is a Node backend and its scripts/eval are CLI tools,
      // where console is the intended logging and output mechanism (there is no
      // browser console to pollute). no-console is a frontend concern, so it is
      // scoped to the frontend (src/) via the base rule above and turned off here.
      files: ['workflow-server/**/*.ts'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
