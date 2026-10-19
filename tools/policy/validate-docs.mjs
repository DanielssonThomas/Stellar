import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const errors = [];
const markdown = [];
const exceptions = new Set([
  'README.md',
  'AGENTS.md',
  'SKILL.md',
  'PULL_REQUEST_TEMPLATE.md',
]);

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === '.nx'
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (extname(entry.name).toLowerCase() === '.md') markdown.push(path);
  }
}

function fail(path, message) {
  errors.push(`${relative(root, path)}: ${message}`);
}

await visit(root);

for (const path of markdown) {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (!exceptions.has(name) && !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) {
    fail(path, 'Markdown filenames must use lowercase kebab-case.');
  }
  const content = await readFile(path, 'utf8');
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split(/[\s#]/, 1)[0].replace(/^<|>$/g, '');
    if (
      !target ||
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      target.startsWith('//')
    )
      continue;
    const resolved = resolve(dirname(path), decodeURIComponent(target));
    try {
      await stat(resolved);
    } catch {
      fail(path, `Broken relative link: ${target}`);
    }
  }
  if (path.includes(`${sep}docs${sep}decisions${sep}`)) {
    for (const required of [
      '## Context',
      '## Decision',
      '## Consequences',
      '## Related references',
    ]) {
      if (!content.includes(required))
        fail(path, `ADR is missing the “${required.slice(3)}” section.`);
    }
    if (!/^# ADR \d+:/m.test(content) || !/^\*\*Status:\*\*/m.test(content)) {
      fail(path, 'ADR requires a numbered title and status.');
    }
  }
}

for (const required of [
  'README.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/documentation-policy.md',
]) {
  if (
    !markdown.some(
      (path) => relative(root, path).split(sep).join('/') === required,
    )
  )
    errors.push(`Missing required document: ${required}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${markdown.length} Markdown documents and relative links.`,
  );
}
