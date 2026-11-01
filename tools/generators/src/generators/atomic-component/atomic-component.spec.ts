import { Tree, readProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { atomicComponentGenerator } from './atomic-component';
import { AtomicComponentGeneratorSchema } from './schema';

describe('atomicComponentGenerator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('.gitignore', '');
    tree.write(
      'libs/ui/atoms/project.json',
      JSON.stringify({
        name: 'ui-atoms',
        root: 'libs/ui/atoms',
        sourceRoot: 'libs/ui/atoms/src',
        projectType: 'library',
        tags: ['scope:shared', 'type:ui', 'layer:atom'],
        targets: {},
      }),
    );
    tree.write('libs/ui/atoms/src/index.ts', '');
    tree.write(
      'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts',
      'export class SkeletonAtom {}\n',
    );
  });

  it('creates a correctly named atom with loading markup and a test', async () => {
    await atomicComponentGenerator(tree, {
      name: 'status-pill',
      layer: 'atom',
    });

    const component = tree.read(
      'libs/ui/atoms/src/lib/atoms/status-pill-atom.component.ts',
      'utf-8',
    );
    expect(component).toContain('export class StatusPillAtom');
    expect(component).toContain('skeleton-atom.component');
    expect(
      tree.read(
        'libs/ui/atoms/src/lib/atoms/status-pill-atom.component.html',
        'utf-8',
      ),
    ).toContain('stellar-skeleton-atom');
    expect(
      tree.read(
        'libs/ui/atoms/src/lib/atoms/status-pill-atom.component.spec.ts',
        'utf-8',
      ),
    ).toContain("setInput('loading', true)");
    expect(tree.read('libs/ui/atoms/src/index.ts', 'utf-8')).toContain(
      "export * from './lib/atoms/status-pill-atom.component';",
    );
  });

  it('creates the requested layer library and its lower-layer import', async () => {
    await atomicComponentGenerator(tree, {
      name: 'account-summary',
      layer: 'molecule',
    });

    const project = readProjectConfiguration(tree, 'ui-molecules');
    expect(project.root).toBe('libs/ui/molecules');
    expect(project.tags).toContain('layer:molecule');
    expect(
      tree.read(
        'libs/ui/molecules/src/lib/molecules/account-summary-molecule.component.ts',
        'utf-8',
      ),
    ).toContain("from '@stellar/ui-atoms'");
    expect(
      tree.exists('libs/ui/molecules/src/lib/ui-molecules/ui-molecules.ts'),
    ).toBe(false);
  });

  it('rejects invalid names and layers', async () => {
    await expect(
      atomicComponentGenerator(tree, { name: 'StatusPill', layer: 'atom' }),
    ).rejects.toThrow('Component name must use lowercase kebab-case.');
    await expect(
      atomicComponentGenerator(tree, {
        name: 'status-pill',
        layer: 'service' as unknown as AtomicComponentGeneratorSchema['layer'],
      }),
    ).rejects.toThrow('Layer must be atom, molecule, organism, or template.');
  });

  it('uses the validated existing template root without migrating other components', async () => {
    tree.write(
      'libs/mission-control/project.json',
      JSON.stringify({
        name: 'ui-templates',
        projectType: 'library',
        sourceRoot: 'libs/mission-control/source',
        tags: ['scope:shared', 'type:ui', 'layer:template'],
      }),
    );
    tree.write(
      'libs/mission-control/source/index.ts',
      'export const retained = true;\n',
    );
    tree.write(
      'libs/mission-control/package.json',
      JSON.stringify({
        name: '@stellar/ui-templates',
        peerDependencies: { '@angular/common': '^21.2.0' },
      }),
    );
    await atomicComponentGenerator(tree, {
      name: 'desktop-experience',
      layer: 'template',
    });
    expect(
      tree.exists(
        'libs/mission-control/source/lib/templates/desktop-experience-template.component.ts',
      ),
    ).toBe(true);
    expect(tree.read('libs/mission-control/source/index.ts', 'utf8')).toContain(
      'retained',
    );
    expect(tree.exists('libs/ui/templates/project.json')).toBe(false);
    expect(
      JSON.parse(tree.read('libs/mission-control/package.json', 'utf8') ?? '{}')
        .peerDependencies['@angular/common'],
    ).toBe('^21.2.0');
  });

  it.each([
    {
      root: 'apps/unsafe',
      sourceRoot: 'apps/unsafe/src',
      tags: ['scope:shared', 'type:ui', 'layer:template'],
    },
    {
      root: 'libs/legacy',
      sourceRoot: 'libs/legacy/../other/src',
      tags: ['scope:shared', 'type:ui', 'layer:template'],
    },
    {
      root: 'libs/legacy',
      sourceRoot: 'libs/other/src',
      tags: ['scope:shared', 'type:ui', 'layer:template'],
    },
    {
      root: 'libs/legacy',
      sourceRoot: 'libs/legacy/src',
      tags: ['scope:shared', 'type:ui', 'layer:organism'],
    },
    {
      root: 'libs/legacy',
      sourceRoot: 'libs/legacy/src',
      tags: ['scope:app', 'scope:shared', 'type:ui', 'layer:template'],
    },
  ])(
    'rejects unsafe or mismatched registered libraries: %j',
    async ({ root, sourceRoot, tags }) => {
      tree.write(
        `${root}/project.json`,
        JSON.stringify({
          name: 'ui-templates',
          projectType: 'library',
          sourceRoot,
          tags,
        }),
      );
      tree.write(`${sourceRoot}/index.ts`, '');
      await expect(
        atomicComponentGenerator(tree, {
          name: 'desktop-experience',
          layer: 'template',
        }),
      ).rejects.toThrow('requires a safe library root');
      expect(
        tree.exists(
          `${root}/src/lib/templates/desktop-experience-template.component.ts`,
        ),
      ).toBe(false);
    },
  );
});
