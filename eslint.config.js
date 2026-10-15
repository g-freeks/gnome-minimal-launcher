import js from '@eslint/js';
import globals from 'globals';

// GJS globals that gnome-shell and extensions can use
const gjsGlobals = {
    global: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    imports: 'readonly',
};

export default [
    {
        ignores: ['.vm/', 'node_modules/'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.es2024,
                ...gjsGlobals,
                console: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        rules: {
            'no-var': 'error',
            'prefer-const': 'error',
            'eqeqeq': ['error', 'smart'],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
        },
    },
    {
        // Tooling that runs under Node, not GJS
        files: ['eslint.config.js'],
        languageOptions: {globals: globals.node},
    },
];
