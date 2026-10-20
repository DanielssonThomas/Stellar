import { Tree, readProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { serviceGenerator } from './service';

describe('serviceGenerator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('.gitignore', '');
  });

  it('creates a shared utility library with injectable and test scaffolding', async () => {
    await serviceGenerator(tree, { name: 'profile-store' });

    const project = readProjectConfiguration(tree, 'service-profile-store');
    expect(project.root).toBe('libs/services/profile-store');
    expect(project.tags).toEqual(['scope:shared', 'type:util']);
    expect(
      tree.read(
        'libs/services/profile-store/src/lib/services/profile-store.service.ts',
        'utf-8',
      ),
    ).toContain('export class ProfileStoreService');
    expect(
      tree.read(
        'libs/services/profile-store/src/lib/services/profile-store.service.spec.ts',
        'utf-8',
      ),
    ).toContain('is injectable as a shared singleton');
    expect(
      tree.read('libs/services/profile-store/src/index.ts', 'utf-8'),
    ).toContain("export * from './lib/services/profile-store.service';");
  });

  it('rejects invalid names and duplicate service libraries', async () => {
    await expect(
      serviceGenerator(tree, { name: 'ProfileStore' }),
    ).rejects.toThrow('Service name must use lowercase kebab-case.');
    await serviceGenerator(tree, { name: 'profile-store' });
    await expect(
      serviceGenerator(tree, { name: 'profile-store' }),
    ).rejects.toThrow('Project already exists: service-profile-store');
  });
});
