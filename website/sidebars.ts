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
      label: 'Production Basics',
      collapsed: false,
      items: [
        'guides/dead-letter-queue',
        'guides/health-checks',
        'guides/graceful-shutdown',
        'guides/storage-budgeting',
      ],
    },
    {
      type: 'category',
      label: 'Observability',
      collapsed: false,
      link: { type: 'doc', id: 'observability/index' },
      items: ['observability/tracing', 'observability/metrics'],
    },
    {
      type: 'category',
      label: 'Operations',
      collapsed: false,
      items: ['guides/lifecycle-hooks', 'guides/stream-migration', 'guides/performance'],
    },
    'guides/troubleshooting',
    {
      type: 'category',
      label: 'Reference',
      collapsed: true,
      items: [
        'reference/module-configuration',
        'reference/naming-conventions',
        'reference/default-configs',
        'reference/edge-cases',
        'reference/header-contract',
        'reference/release-notes',
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
