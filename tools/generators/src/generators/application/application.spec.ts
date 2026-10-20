import { getApplicationOptions } from './application';

describe('getApplicationOptions', () => {
  it('applies the Angular, Playwright, and tag defaults', () => {
    expect(getApplicationOptions('admin-portal')).toEqual({
      name: 'admin-portal',
      directory: 'apps/admin-portal',
      tags: 'scope:app,type:app',
      e2eTestRunner: 'playwright',
      linter: 'eslint',
      prefix: 'stellar',
      style: 'css',
      unitTestRunner: 'vitest-angular',
      routing: true,
      standalone: true,
      skipTests: false,
    });
  });
});
