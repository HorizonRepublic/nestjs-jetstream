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
      items: [
        'getting-started/why-jetstream',
        'getting-started/installation',
        'getting-started/quick-start',
      ],
    },
    {
      type: 'category',
      label: 'Core Concepts',
      collapsed: false,
      items: [
        'patterns/events',
        'patterns/rpc',
        'guides/record-builder',
        'guides/handler-context',
      ],
    },
    {
      type: 'category',
      label: 'Advanced Patterns',
      collapsed: false,
      items: [
        'patterns/broadcast',
        'patterns/ordered-events',
        'patterns/handler-metadata',
        'guides/scheduling',
        'guides/per-message-ttl',
      ],
    },
    {
      type: 'category',
      label: 'Going to Production',
      collapsed: false,
      items: [
        'getting-started/module-configuration',
        'guides/dead-letter-queue',
        'guides/health-checks',
        'guides/lifecycle-hooks',
        'guides/graceful-shutdown',
        'guides/stream-migration',
        'guides/performance',
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
        'guides/custom-codec',
        'guides/migration',
        'guides/troubleshooting',
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
      collapsed: true,
      items: ['development/testing', 'development/contributing'],
    },
  ],
};

export default sidebars;
