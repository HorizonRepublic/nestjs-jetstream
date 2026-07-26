/**
 * Local oxlint rules covering conventions that have no upstream equivalent
 * in oxlint's built-in rule set.
 */

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

/** Reports a type-level identifier that is not PascalCase. */
const reportUnlessPascalCase = (context, node, kind) => {
  if (node === null || node.type !== 'Identifier' || PASCAL_CASE.test(node.name)) {
    return;
  }

  context.report({ node, message: `${kind} name "${node.name}" must be PascalCase.` });
};

const typePascalCase = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require PascalCase for type-level declarations.' },
  },
  create: (context) => {
    return {
      TSInterfaceDeclaration: (node) => {
        reportUnlessPascalCase(context, node.id, 'Interface');
      },
      TSTypeAliasDeclaration: (node) => {
        reportUnlessPascalCase(context, node.id, 'Type alias');
      },
      TSEnumDeclaration: (node) => {
        reportUnlessPascalCase(context, node.id, 'Enum');
      },
      TSEnumMember: (node) => {
        reportUnlessPascalCase(context, node.id, 'Enum member');
      },
      ClassDeclaration: (node) => {
        reportUnlessPascalCase(context, node.id, 'Class');
      },
    };
  },
};

const noNestedConditional = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow ternary expressions nested inside another ternary.' },
  },
  create: (context) => {
    const report = (node) => {
      context.report({
        node,
        message: 'Nested ternary expression - use a lookup map or if/else instead.',
      });
    };

    return {
      ConditionalExpression: (node) => {
        for (const branch of [node.test, node.consequent, node.alternate]) {
          if (branch?.type === 'ConditionalExpression') {
            report(branch);
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'local' },
  rules: {
    'type-pascal-case': typePascalCase,
    'no-nested-conditional': noNestedConditional,
  },
};
