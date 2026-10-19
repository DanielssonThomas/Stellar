module.exports = {
  extends: ['@commitlint/config-conventional'],
  parserPreset: {
    parserOpts: {
      headerPattern:
        /^\[#([1-9][0-9]*)\] (feat|fix|refactor|test|docs|chore|build|ci)(?:\(([a-z0-9][a-z0-9._/-]*)\))?: (.+)$/,
      headerCorrespondence: ['issue', 'type', 'scope', 'subject'],
    },
  },
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'build', 'ci'],
    ],
    'subject-empty': [2, 'never'],
    'subject-min-length': [2, 'always', 5],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 120],
  },
};
