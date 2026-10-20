import { formatFiles, Tree } from '@nx/devkit';
import {
  applicationGenerator as angularApplicationGenerator,
  E2eTestRunner,
  UnitTestRunner,
} from '@nx/angular/generators';
import { assertKebabCase } from '../utils';
import { ApplicationGeneratorSchema } from './schema';

export async function applicationGenerator(
  tree: Tree,
  options: ApplicationGeneratorSchema,
): Promise<void> {
  const name = assertKebabCase(options.name, 'Application name');

  await angularApplicationGenerator(tree, getApplicationOptions(name));
  customizeApplication(tree, name);

  await formatFiles(tree);
}

function customizeApplication(tree: Tree, name: string): void {
  const appRoot = `apps/${name}/src/app`;
  const title = name
    .split('-')
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
  const appComponent = `${appRoot}/app.component.ts`;
  const appTemplate = `${appRoot}/app.component.html`;
  const appStyles = `${appRoot}/app.component.css`;
  const appSpec = `${appRoot}/app.component.spec.ts`;

  tree.delete(`${appRoot}/app.ts`);
  tree.delete(`${appRoot}/app.html`);
  tree.delete(`${appRoot}/app.css`);
  tree.delete(`${appRoot}/app.spec.ts`);
  tree.delete(`${appRoot}/nx-welcome.ts`);
  tree.write(
    appComponent,
    `import { Component } from '@angular/core';\nimport { RouterOutlet } from '@angular/router';\n\n@Component({\n  imports: [RouterOutlet],\n  selector: 'stellar-root',\n  templateUrl: './app.component.html',\n  styleUrl: './app.component.css',\n})\nexport class AppComponent {\n  readonly title = '${title}';\n}\n`,
  );
  tree.write(
    appTemplate,
    `<main>\n  <h1>{{ title }}</h1>\n  <router-outlet />\n</main>\n`,
  );
  tree.write(appStyles, ':host {\n  display: block;\n}\n');
  tree.write(
    `apps/${name}/src/main.ts`,
    `import { bootstrapApplication } from '@angular/platform-browser';\nimport { appConfig } from './app/app.config';\nimport { AppComponent } from './app/app.component';\n\nbootstrapApplication(AppComponent, appConfig).catch((error: unknown) => console.error(error));\n`,
  );
  tree.write(
    appSpec,
    `import { TestBed } from '@angular/core/testing';\nimport { describe, expect, it } from 'vitest';\nimport { AppComponent } from './app.component';\n\ndescribe('AppComponent', () => {\n  it('renders the application name', async () => {\n    await TestBed.configureTestingModule({ imports: [AppComponent] }).compileComponents();\n    const fixture = TestBed.createComponent(AppComponent);\n    await fixture.whenStable();\n\n    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('${title}');\n  });\n});\n`,
  );

  tree.write(
    `apps/${name}-e2e/src/example.spec.ts`,
    `import { expect, test } from '@playwright/test';\n\ntest('renders the application shell', async ({ page }) => {\n  await page.goto('/');\n\n  await expect(page.getByRole('heading', { name: '${title}' })).toBeVisible();\n});\n`,
  );

  const e2eConfigPath = `apps/${name}-e2e/playwright.config.ts`;
  const e2eConfig = tree.read(e2eConfigPath, 'utf-8');
  if (e2eConfig === null) {
    throw new Error(`Generated Playwright config not found: ${e2eConfigPath}`);
  }
  const configuredE2e = e2eConfig.replace(
    `command: 'pnpm exec nx run ${name}:serve'`,
    `command: 'corepack pnpm exec nx run ${name}:serve'`,
  );
  const projectsStart = configuredE2e.indexOf('  projects: [');
  const projectsEnd = configuredE2e.lastIndexOf('\n  ],\n});');
  if (projectsStart === -1 || projectsEnd === -1) {
    throw new Error(
      `Generated Playwright projects not found: ${e2eConfigPath}`,
    );
  }
  tree.write(
    e2eConfigPath,
    `${configuredE2e.slice(0, projectsStart)}  projects: [\n    {\n      name: 'chromium',\n      use: { ...devices['Desktop Chrome'] },\n    },\n  ]${configuredE2e.slice(projectsEnd + '\n  ],'.length)}`,
  );
}

export function getApplicationOptions(
  name: string,
): Parameters<typeof angularApplicationGenerator>[1] {
  return {
    name,
    directory: `apps/${name}`,
    tags: 'scope:app,type:app',
    e2eTestRunner: E2eTestRunner.Playwright,
    linter: 'eslint',
    prefix: 'stellar',
    style: 'css',
    unitTestRunner: UnitTestRunner.VitestAngular,
    routing: true,
    standalone: true,
    skipTests: false,
  };
}

export default applicationGenerator;
