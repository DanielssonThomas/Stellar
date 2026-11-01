import {
  formatFiles,
  getProjects,
  readProjectConfiguration,
  Tree,
} from '@nx/devkit';
import {
  libraryGenerator as angularLibraryGenerator,
  UnitTestRunner,
} from '@nx/angular/generators';
import { assertKebabCase, toPascalCase } from '../utils';
import { AtomicComponentGeneratorSchema } from './schema';

const layers = {
  atom: { plural: 'atoms', suffix: 'Atom' },
  molecule: { plural: 'molecules', suffix: 'Molecule' },
  organism: { plural: 'organisms', suffix: 'Organism' },
  template: { plural: 'templates', suffix: 'Template' },
} as const;

type Layer = keyof typeof layers;

export async function atomicComponentGenerator(
  tree: Tree,
  options: AtomicComponentGeneratorSchema,
): Promise<void> {
  const name = assertKebabCase(options.name, 'Component name');
  const layer = options.layer as Layer;
  const layerOptions = layers[layer];
  if (!layerOptions) {
    throw new Error('Layer must be atom, molecule, organism, or template.');
  }

  const projectName = `ui-${layerOptions.plural}`;
  let projectRoot = `libs/ui/${layerOptions.plural}`;
  let librarySourceRoot = `${projectRoot}/src`;
  const projects = getProjects(tree);

  if (!projects.has(projectName)) {
    await angularLibraryGenerator(tree, {
      name: projectName,
      directory: projectRoot,
      buildable: true,
      linter: 'eslint',
      prefix: 'stellar',
      tags: `scope:shared,type:ui,layer:${layer}`,
      unitTestRunner: UnitTestRunner.VitestAngular,
    });
    removeLibraryPlaceholder(tree, projectRoot, projectName);
  } else {
    const project = readProjectConfiguration(tree, projectName);
    const safeRoot = /^libs\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/;
    const requiredTags = ['scope:shared', 'type:ui', `layer:${layer}`];
    if (
      project.projectType !== 'library' ||
      !requiredTags.every((tag) => project.tags?.includes(tag)) ||
      project.tags?.some(
        (tag) =>
          /^(scope|type|layer):/.test(tag) && !requiredTags.includes(tag),
      ) ||
      !safeRoot.test(project.root) ||
      !project.sourceRoot ||
      !safeRoot.test(project.sourceRoot) ||
      !project.sourceRoot.startsWith(`${project.root}/`) ||
      !tree.exists(`${project.sourceRoot}/index.ts`)
    ) {
      throw new Error(
        `Project ${projectName} requires a safe library root, source entry point and matching shared UI layer tags.`,
      );
    }
    projectRoot = project.root;
    librarySourceRoot = project.sourceRoot;
  }
  if (layer !== 'atom') configureLayerManifest(tree, projectRoot);

  const baseName = `${name}-${layer}`;
  const sourceRoot = `${librarySourceRoot}/lib/${layerOptions.plural}`;
  const componentPath = `${sourceRoot}/${baseName}.component.ts`;
  const templatePath = `${sourceRoot}/${baseName}.component.html`;
  const stylePath = `${sourceRoot}/${baseName}.component.css`;
  const specPath = `${sourceRoot}/${baseName}.component.spec.ts`;
  for (const path of [componentPath, templatePath, stylePath, specPath]) {
    if (tree.exists(path)) {
      throw new Error(`File already exists: ${path}`);
    }
  }

  const className = `${toPascalCase(name)}${layerOptions.suffix}`;
  const selector = `stellar-${baseName}`;
  const skeletonImport =
    layer === 'atom'
      ? "import { SkeletonAtom } from './skeleton-atom.component';"
      : "import { SkeletonAtom } from '@stellar/ui-atoms';";

  tree.write(
    componentPath,
    `import { Component, input } from '@angular/core';\n${skeletonImport}\n\n@Component({\n  selector: '${selector}',\n  standalone: true,\n  imports: [SkeletonAtom],\n  templateUrl: './${baseName}.component.html',\n  styleUrl: './${baseName}.component.css',\n  host: { '[attr.aria-busy]': 'loading()' },\n})\nexport class ${className} {\n  readonly content = input('Sample content');\n  readonly loading = input(false);\n}\n`,
  );
  tree.write(
    templatePath,
    `@if (loading()) {\n  <stellar-skeleton-atom shape="text" />\n} @else {\n  <span>{{ content() }}</span>\n}\n`,
  );
  tree.write(stylePath, ':host {\n  display: block;\n}\n');
  tree.write(
    specPath,
    `import { ComponentFixture, TestBed } from '@angular/core/testing';\nimport { beforeEach, describe, expect, it } from 'vitest';\nimport { ${className} } from './${baseName}.component';\n\ndescribe('${className}', () => {\n  let fixture: ComponentFixture<${className}>;\n\n  beforeEach(async () => {\n    await TestBed.configureTestingModule({ imports: [${className}] }).compileComponents();\n    fixture = TestBed.createComponent(${className});\n    await fixture.whenStable();\n  });\n\n  it('renders its content', () => {\n    expect(fixture.nativeElement.textContent).toContain('Sample content');\n  });\n\n  it('shows a skeleton while loading', async () => {\n    fixture.componentRef.setInput('loading', true);\n    await fixture.whenStable();\n\n    expect(fixture.nativeElement.querySelector('stellar-skeleton-atom')).not.toBeNull();\n    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');\n  });\n});\n`,
  );
  appendExport(
    tree,
    `${librarySourceRoot}/index.ts`,
    `./lib/${layerOptions.plural}/${baseName}.component`,
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

function configureLayerManifest(tree: Tree, projectRoot: string): void {
  const manifestPath = `${projectRoot}/package.json`;
  const atomsManifestPath = 'libs/ui/atoms/package.json';
  const manifest = JSON.parse(readText(tree, manifestPath)) as {
    peerDependencies?: Record<string, string>;
  };
  const atomsManifest = tree.exists(atomsManifestPath)
    ? (JSON.parse(readText(tree, atomsManifestPath)) as { version?: string })
    : undefined;
  manifest.peerDependencies ??= {};
  delete manifest.peerDependencies['@angular/common'];
  manifest.peerDependencies['@stellar/ui-atoms'] = atomsManifest?.version
    ? 'workspace:^'
    : '*';
  tree.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readText(tree: Tree, path: string): string {
  const content = tree.read(path, 'utf-8');
  if (content === null) throw new Error(`File not found: ${path}`);
  return content;
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

export default atomicComponentGenerator;
