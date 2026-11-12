module.exports = [
  {
    files: ['**/*.js'],
    // js/vendor/ holds unmodified third-party bundles (e.g. Mediabunny) — not ours to lint.
    ignores: ['node_modules/**', 'js/vendor/**'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module'
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'off'
    }
  }
];
