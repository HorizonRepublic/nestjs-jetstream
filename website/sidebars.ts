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
        'guides/migration',
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
        'guides/custom-codec',
      ],
    },
    {
      type: 'category',
      label: 'Production basics',
      collapsed: false,
      items: [
        'getting-started/module-configuration',
        'guides/dead-letter-queue',
        'guides/health-checks',
        'guides/graceful-shutdown',
      ],
    },
    {
      type: 'category',
      label: 'Operations',
      collapsed: false,
      items: [
        'guides/lifecycle-hooks',
        'guides/distributed-tracing',
        'guides/stream-migration',
        'guides/performance',
      ],
    },
    'guides/troubleshooting',
    {
      type: 'category',
      label: 'Reference',
      collapsed: true,
      items: [
        'reference/naming-conventions',
        'reference/default-configs',
        'reference/edge-cases',
        'reference/header-contract',
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
    {
      type: 'link',
      label: "What's new",
      href: 'https://github.com/HorizonRepublic/nestjs-jetstream/releases',
    },
  ],
};

export default sidebars;
