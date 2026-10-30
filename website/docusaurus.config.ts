import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import npm2yarn from '@docusaurus/remark-plugin-npm2yarn';
import rehypeJetstream from './src/plugins/rehype-jetstream.mjs';

const config: Config = {
  title: '@horizon-republic/nestjs-jetstream',
  tagline: 'Durable events, broadcast, ordered delivery and RPC for NestJS, backed by NATS JetStream',
  favicon: 'img/favicon.svg',
  url: 'https://nestjs-jetstream.horizon-republic.dev',
  baseUrl: '/',
  organizationName: 'HorizonRepublic',
  projectName: 'nestjs-jetstream',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  markdown: {
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  clientModules: ['./src/clientModules/mermaidZoom.js'],
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/HorizonRepublic/nestjs-jetstream/tree/main/website/',
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
          remarkPlugins: [[npm2yarn, { sync: true, converters: ['pnpm', 'yarn'] }]],
          rehypePlugins: [rehypeJetstream],
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
        sitemap: {
          // priority/changefreq are mostly ignored by Google. lastmod is the
          // signal that actually moves the needle, pulled from git for each doc.
          lastmod: 'date',
          changefreq: 'weekly',
          priority: 0.5,
          filename: 'sitemap.xml',
          // The generated API reference carries `noindex` and the plugin drops
          // those on its own; /404 has no such tag and has to be named. Category
          // indexes are link lists, and development pages are for contributors.
          ignorePatterns: ['/404', '/docs/category/**', '/docs/development/**'],
        },
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
    'docusaurus-plugin-llms',
    [
      '@coffeecup_tech/docusaurus-plugin-structured-data',
      {
        verbose: true,
        docsDir: 'docs',
        baseSchema: {
          organization: {
            '@type': 'Organization',
            // Article.publisher and WebPage.publisher reference this @id.
            '@id': '${DOCUSAURUS_CONFIG_URL}/#organization',
            name: 'Horizon Republic',
            url: '${DOCUSAURUS_CONFIG_URL}',
          },
          // WebPage.isPartOf references this @id on every route.
          website: {
            '@type': 'WebSite',
            '@id': '${DOCUSAURUS_CONFIG_URL}/#website',
            name: '@horizon-republic/nestjs-jetstream',
            description:
              'A NATS JetStream transport for NestJS microservices: durable events, broadcast, ordered delivery, RPC and dead letters.',
            url: '${DOCUSAURUS_CONFIG_URL}',
            publisher: { '@id': '${DOCUSAURUS_CONFIG_URL}/#organization' },
          },
        },
      },
    ],
  ],
  headTags: [
    { tagName: 'link', attributes: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
    { tagName: 'link', attributes: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' } },
    {
      tagName: 'link',
      attributes: {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
      },
    },
    { tagName: 'link', attributes: { rel: 'icon', type: 'image/png', sizes: '48x48', href: '/img/favicon-48.png' } },
    { tagName: 'link', attributes: { rel: 'icon', type: 'image/png', sizes: '96x96', href: '/img/favicon-96.png' } },
    { tagName: 'link', attributes: { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/img/favicon-192.png' } },
    { tagName: 'link', attributes: { rel: 'icon', type: 'image/png', sizes: '512x512', href: '/img/favicon-512.png' } },
    { tagName: 'link', attributes: { rel: 'apple-touch-icon', sizes: '180x180', href: '/img/apple-touch-icon.png' } },
    {
      tagName: 'meta',
      attributes: {
        name: 'keywords',
        content: 'NestJS NATS, NestJS NATS transport, NestJS JetStream, NATS JetStream, NestJS microservice transport, NestJS NATS transporter, dead letter queue, broadcast events, ordered events, RPC, Node.js, TypeScript',
      },
    },
    {
      tagName: 'script',
      attributes: {
        type: 'application/ld+json',
      },
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareSourceCode',
        name: '@horizon-republic/nestjs-jetstream',
        alternateName: 'NestJS NATS Transport',
        description:
          'NestJS NATS transport powered by JetStream: durable events, broadcast, ordered delivery, RPC and dead letter queues for production microservices.',
        programmingLanguage: 'TypeScript',
        runtimePlatform: 'Node.js',
        codeRepository: 'https://github.com/HorizonRepublic/nestjs-jetstream',
        license: 'https://github.com/HorizonRepublic/nestjs-jetstream/blob/main/LICENSE',
        keywords:
          'NestJS NATS, NestJS JetStream, NATS JetStream transport, NestJS microservice',
      }),
    },
  ],
  themeConfig: {
    image: 'img/og-image.png',
    metadata: [
      { name: 'google-site-verification', content: 'wuC1grxtPowMVSi5W2hFEB2W_rRe4bhOA-xaynJNKbg' },
      { name: 'description', content: 'NestJS NATS transport powered by JetStream: durable events, broadcast, ordered delivery, RPC and dead letter queues for production microservices.' },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: 'nestjs-jetstream: production NATS JetStream transport for NestJS' },
      { property: 'og:description', content: 'Durable, retried and traced NATS JetStream transport for NestJS, under the same @EventPattern decorators you already use.' },
      { property: 'og:site_name', content: 'nestjs-jetstream' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: 'nestjs-jetstream: production NATS JetStream transport for NestJS' },
      { name: 'twitter:description', content: 'Durable, retried and traced NATS JetStream transport for NestJS, under the same @EventPattern decorators you already use.' },
    ],
    mermaid: {
      theme: { light: 'neutral', dark: 'dark' },
      options: {
        securityLevel: 'loose',
        // Layout is measured with these fonts, so set them here, not in CSS.
        fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
        themeVariables: { fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif', fontSize: '14px' },
        flowchart: {
          curve: 'basis',
          padding: 18,
          nodeSpacing: 50,
          rankSpacing: 60,
          htmlLabels: true,
          useMaxWidth: false,
        },
        sequence: {
          actorMargin: 60,
          boxMargin: 12,
          messageMargin: 40,
          mirrorActors: false,
          showSequenceNumbers: true,
          actorFontSize: 14,
          messageFontSize: 14,
          noteFontSize: 13,
          useMaxWidth: false,
        },
      },
    },
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'nestjs-jetstream',
      items: [
        { to: '/docs/', label: 'Docs', position: 'left', activeBaseRegex: '/docs(?!/reference/api)' },
        { to: '/docs/reference/api', label: 'API Reference', position: 'left', activeBaseRegex: '/docs/reference/api' },
        { href: 'https://github.com/HorizonRepublic/nestjs-jetstream/releases', label: 'Changelog', position: 'right' },
        { href: 'https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream', label: 'npm', position: 'right' },
        { href: 'https://github.com/HorizonRepublic/nestjs-jetstream', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Start', to: '/docs/getting-started/installation' },
            { label: 'Delivery patterns', to: '/docs/patterns/events' },
            { label: 'Reference', to: '/docs/reference/module-configuration' },
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
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ['bash', 'json', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
