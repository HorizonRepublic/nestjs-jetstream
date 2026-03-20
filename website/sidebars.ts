import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const typedocItems = require('./docs/reference/api/typedoc-sidebar.cjs');

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: ['getting-started/installation', 'getting-started/quick-start', 'getting-started/module-configuration'],
    },
    {
      type: 'category',
      label: 'Messaging Patterns',
      collapsed: false,
      items: ['patterns/rpc', 'patterns/events', 'patterns/broadcast', 'patterns/ordered-events'],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsed: false,
      items: [
        'guides/record-builder',
        'guides/handler-context',
        'guides/custom-codec',
        'guides/dead-letter-queue',
        'guides/health-checks',
        'guides/lifecycle-hooks',
        'guides/graceful-shutdown',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: [
        'reference/naming-conventions',
        'reference/default-configs',
        'reference/edge-cases',
      ],
    },
    {
      type: 'category',
      label: 'API Reference',
      collapsed: true,
      link: { type: 'doc', id: 'reference/api/index' },
      items: typedocItems,
    },
    {
      type: 'category',
      label: 'Development',
      collapsed: false,
      items: ['development/testing', 'development/contributing'],
    },
  ],
};

export default sidebars;
