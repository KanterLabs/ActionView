// Flat config (ESLint 10). Run: npx --yes eslint@10 .
export default [
    {
        ignores: ['build/**', 'node_modules/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                // GJS / GNOME Shell runtime
                global: 'readonly', imports: 'readonly', log: 'readonly', logError: 'readonly',
                print: 'readonly', console: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
                // Node, for tests/core.test.js only
                process: 'readonly', URL: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'no-undef': 'error',
            'no-shadow': 'error',
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': ['error', 'always'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'no-console': 'off',
        },
    },
];
