import { formatFiles, getProjects, Tree } from '@nx/devkit';
import {
  libraryGenerator as angularLibraryGenerator,
  UnitTestRunner,
} from '@nx/angular/generators';
import { assertKebabCase, toPascalCase } from '../utils';
import { ServiceGeneratorSchema } from './schema';

export async function serviceGenerator(
  tree: Tree,
  options: ServiceGeneratorSchema,
): Promise<void> {
  const name = assertKebabCase(options.name, 'Service name');
  const projectName = `service-${name}`;
  const projectRoot = `libs/services/${name}`;

  if (getProjects(tree).has(projectName)) {
    throw new Error(`Project already exists: ${projectName}`);
  }

  await angularLibraryGenerator(tree, {
    name: projectName,
    directory: projectRoot,
    buildable: true,
    linter: 'eslint',
    prefix: 'stellar',
    tags: 'scope:shared,type:util',
    unitTestRunner: UnitTestRunner.VitestAngular,
  });
  removeLibraryPlaceholder(tree, projectRoot, projectName);
  removeUnusedCommonPeerDependency(tree, projectRoot);

  const className = `${toPascalCase(name)}Service`;
  const sourceDirectory = `${projectRoot}/src/lib/services`;
  const serviceFile = `${sourceDirectory}/${name}.service.ts`;
  const specFile = `${sourceDirectory}/${name}.service.spec.ts`;

  tree.write(
    serviceFile,
    `import { Injectable } from '@angular/core';\n\n@Injectable({ providedIn: 'root' })\nexport class ${className} {}\n`,
  );
  tree.write(
    specFile,
    `import { TestBed } from '@angular/core/testing';\nimport { describe, expect, it } from 'vitest';\nimport { ${className} } from './${name}.service';\n\ndescribe('${className}', () => {\n  it('is injectable as a shared singleton', () => {\n    TestBed.configureTestingModule({ providers: [${className}] });\n\n    const first = TestBed.inject(${className});\n    const second = TestBed.inject(${className});\n\n    expect(first).toBeInstanceOf(${className});\n    expect(second).toBe(first);\n  });\n});\n`,
  );

  appendExport(
    tree,
    `${projectRoot}/src/index.ts`,
    `./lib/services/${name}.service`,
  );
  await formatFiles(tree);
}

function removeLibraryPlaceholder(
  tree: Tree,
  projectRoot: string,
  projectName: string,
): void {
  const placeholderRoot = `${projectRoot}/src/lib/${projectName}/${projectName}`;
  for (const extension of ['ts', 'spec.ts', 'html', 'css']) {
    const path = `${placeholderRoot}.${extension}`;
    if (tree.exists(path)) tree.delete(path);
  }
  const indexPath = `${projectRoot}/src/index.ts`;
  if (tree.exists(indexPath)) tree.write(indexPath, '');
}

function appendExport(
  tree: Tree,
  indexPath: string,
  relativePath: string,
): void {
  const exportLine = `export * from '${relativePath}';`;
  const current = tree.exists(indexPath) ? tree.read(indexPath, 'utf-8') : null;
  if (current === null) {
    throw new Error(`Library entry point not found: ${indexPath}`);
  }
  if (!current.includes(exportLine)) {
    tree.write(
      indexPath,
      `${current.trimEnd()}${current.trim() ? '\n' : ''}${exportLine}\n`,
    );
  }
}

function removeUnusedCommonPeerDependency(
  tree: Tree,
  projectRoot: string,
): void {
  const manifestPath = `${projectRoot}/package.json`;
  const content = tree.read(manifestPath, 'utf-8');
  if (content === null) throw new Error(`File not found: ${manifestPath}`);
  const manifest = JSON.parse(content) as {
    peerDependencies?: Record<string, string>;
  };
  if (manifest.peerDependencies) {
    delete manifest.peerDependencies['@angular/common'];
    tree.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export default serviceGenerator;
