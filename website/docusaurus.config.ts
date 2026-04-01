import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: '@horizon-republic/nestjs-jetstream',
  tagline: 'Ship reliable microservices with NATS JetStream and NestJS',
  favicon: 'img/favicon.svg',
  url: 'https://horizonrepublic.github.io',
  baseUrl: '/nestjs-jetstream/',
  organizationName: 'HorizonRepublic',
  projectName: 'nestjs-jetstream',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  markdown: {
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/HorizonRepublic/nestjs-jetstream/tree/main/website/',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@cmfcmf/docusaurus-search-local',
      {
        language: ['en'],
        indexBlog: false,
      },
    ],
  ],
  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        entryPoints: ['../src/index.ts'],
        tsconfig: '../tsconfig.json',
        out: 'docs/reference/api',
        readme: 'none',
        excludePrivate: true,
        excludeInternal: true,
        excludeExternals: true,
        skipErrorChecking: true,
        useHTMLEncodedBrackets: true,
        pageTitleTemplates: {
          index: '{projectName}',
          member: '{name}',
          module: '{name}',
        },
      },
    ],
    'docusaurus-plugin-llms',
    [
      '@coffeecup_tech/docusaurus-plugin-structured-data',
      {
        verbose: true,
        docsDir: 'docs',
        baseSchema: {
          organization: {
            '@type': 'Organization',
            name: 'Horizon Republic',
            url: '${DOCUSAURUS_CONFIG_URL}',
          },
        },
      },
    ],
  ],
  headTags: [
    { tagName: 'meta', attributes: { name: 'keywords', content: 'NestJS, NATS, JetStream, microservices, message queue, event-driven, Node.js, TypeScript' } },
  ],
  themeConfig: {
    metadata: [
      { name: 'description', content: 'Events, broadcast, ordered delivery, and RPC for NestJS — powered by NATS JetStream.' },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: '@horizon-republic/nestjs-jetstream' },
      { property: 'og:description', content: 'Ship reliable microservices with NATS JetStream and NestJS — events, broadcast, ordered delivery, and RPC.' },
      { name: 'twitter:card', content: 'summary' },
    ],
    mermaid: {
      theme: { light: 'dark', dark: 'dark' },
      options: {
        themeVariables: {
          primaryColor: '#151D2E',
          primaryTextColor: '#E2E8F0',
          primaryBorderColor: '#1E293B',
          lineColor: '#3B82F6',
          secondaryColor: '#0E1525',
          tertiaryColor: '#0B1120',
          noteBkgColor: '#151D2E',
          noteTextColor: '#94A3B8',
          noteBorderColor: '#1E293B',
          actorBkg: '#151D2E',
          actorTextColor: '#E2E8F0',
          actorBorder: '#3B82F6',
          signalColor: '#E2E8F0',
          signalTextColor: '#E2E8F0',
        },
      },
    },
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'nestjs-jetstream',
      items: [
        { type: 'docSidebar', sidebarId: 'docsSidebar', position: 'left', label: 'Docs' },
        { to: '/docs/reference/api', label: 'API Reference', position: 'left' },
        { href: 'https://github.com/HorizonRepublic/nestjs-jetstream/releases', label: 'Changelog', position: 'right' },
        { href: 'https://github.com/HorizonRepublic/nestjs-jetstream', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/docs/getting-started/installation' },
            { label: 'Messaging Patterns', to: '/docs/patterns/rpc' },
            { label: 'Guides', to: '/docs/guides/record-builder' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'GitHub', href: 'https://github.com/HorizonRepublic/nestjs-jetstream' },
            { label: 'Issues', href: 'https://github.com/HorizonRepublic/nestjs-jetstream/issues' },
            { label: 'Discussions', href: 'https://github.com/HorizonRepublic/nestjs-jetstream/discussions' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'npm', href: 'https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream' },
            { label: 'Changelog', href: 'https://github.com/HorizonRepublic/nestjs-jetstream/releases' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Horizon Republic. MIT License.`,
    },
    prism: {
      theme: prismThemes.dracula,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
