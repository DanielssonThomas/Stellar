import nx from '@nx/eslint-plugin';
import stellar from './tools/policy/eslint-plugin-stellar.mjs';

export default [
  {
    files: ['**/*.json'],
    // Override or add rules here
    rules: {},
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    plugins: { stellar },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: 'scope:app',
              onlyDependOnLibsWithTags: ['scope:shared'],
            },
            {
              sourceTag: 'scope:shared',
              onlyDependOnLibsWithTags: ['scope:shared'],
            },
            {
              sourceTag: 'layer:atom',
              onlyDependOnLibsWithTags: [
                'layer:atom',
                'layer:token',
                'type:model',
                'type:util',
              ],
            },
            {
              sourceTag: 'layer:molecule',
              onlyDependOnLibsWithTags: [
                'layer:atom',
                'layer:molecule',
                'layer:token',
                'type:model',
                'type:util',
              ],
            },
            {
              sourceTag: 'layer:organism',
              onlyDependOnLibsWithTags: [
                'layer:atom',
                'layer:molecule',
                'layer:organism',
                'layer:token',
                'type:model',
                'type:util',
              ],
            },
            {
              sourceTag: 'layer:template',
              onlyDependOnLibsWithTags: [
                'layer:atom',
                'layer:molecule',
                'layer:organism',
                'layer:template',
                'layer:token',
                'type:model',
                'type:util',
              ],
            },
            {
              sourceTag: 'type:model',
              onlyDependOnLibsWithTags: ['type:model'],
            },
            {
              sourceTag: 'type:util',
              onlyDependOnLibsWithTags: ['type:model', 'type:util'],
            },
          ],
        },
      ],
      'stellar/atomic-component-name': 'error',
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
