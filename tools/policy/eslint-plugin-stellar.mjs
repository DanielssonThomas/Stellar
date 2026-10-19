const layers = new Map([
  ['atoms', 'Atom'],
  ['molecules', 'Molecule'],
  ['organisms', 'Organism'],
  ['templates', 'Template'],
]);

const atomicComponentName = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce atomic-design component names and filenames',
    },
    schema: [],
    messages: {
      filename:
        'Angular components must use kebab-case and end in .component.ts.',
      layer:
        'Components in {{folder}} must end in {{suffix}} and use a matching -{{slug}}.component.ts filename.',
      defaultClass:
        'Angular component classes outside atomic layers must end in Component.',
    },
  },
  create(context) {
    const file = context.filename.replaceAll('\\', '/');
    const folder = [...layers.keys()].find((entry) =>
      file.split('/').includes(entry),
    );

    function isComponent(node) {
      return node.decorators?.some(
        ({ expression }) =>
          expression.type === 'CallExpression' &&
          expression.callee.type === 'Identifier' &&
          expression.callee.name === 'Component',
      );
    }

    return {
      ClassDeclaration(node) {
        if (!isComponent(node)) return;
        const basename = file.slice(file.lastIndexOf('/') + 1);
        if (!basename.endsWith('.component.ts')) {
          context.report({ node, messageId: 'filename' });
          return;
        }
        if (!folder) {
          if (!node.id?.name.endsWith('Component'))
            context.report({ node, messageId: 'defaultClass' });
          return;
        }

        const suffix = layers.get(folder);
        const slug = suffix[0].toLowerCase() + suffix.slice(1);
        const expectedFile = new RegExp(
          `^[a-z0-9]+(?:-[a-z0-9]+)*-${slug}\\.component\\.ts$`,
        );
        if (!node.id?.name.endsWith(suffix) || !expectedFile.test(basename)) {
          context.report({
            node,
            messageId: 'layer',
            data: { folder, suffix, slug },
          });
        }
      },
    };
  },
};

export default {
  rules: { 'atomic-component-name': atomicComponentName },
};
