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
});
