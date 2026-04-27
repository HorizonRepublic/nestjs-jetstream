import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: '@horizon-republic/nestjs-jetstream',
  tagline: 'The NestJS NATS transport backed by JetStream — durable events, broadcast, ordered delivery, and RPC',
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
          
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
        sitemap: {
          // priority/changefreq are mostly ignored by Google. lastmod is the
          // signal that actually moves the needle — pulled from git for each doc.
          lastmod: 'date',
          changefreq: 'weekly',
          priority: 0.5,
          filename: 'sitemap.xml',
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
          'NestJS NATS transport powered by JetStream — durable events, broadcast, ordered delivery, RPC, and dead letter queues for production microservices.',
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
      { name: 'description', content: 'NestJS NATS transport powered by JetStream — durable events, broadcast, ordered delivery, RPC, and dead letter queues for production microservices.' },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: 'nestjs-jetstream — Production NATS JetStream transport for NestJS' },
      { property: 'og:description', content: 'The NATS JetStream transport NestJS microservices need — durable, retried, traced — under the same @EventPattern decorators.' },
      { property: 'og:site_name', content: 'nestjs-jetstream' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: 'nestjs-jetstream — Production NATS JetStream transport for NestJS' },
      { name: 'twitter:description', content: 'The NATS JetStream transport NestJS microservices need — durable, retried, traced — under the same @EventPattern decorators.' },
    ],
    mermaid: {
      theme: { light: 'dark', dark: 'dark' },
      options: {
        securityLevel: 'loose',
        fontFamily: '"Geist Mono", ui-monospace, monospace',
        flowchart: {
          curve: 'basis',
          padding: 18,
          nodeSpacing: 50,
          rankSpacing: 60,
          htmlLabels: true,
          useMaxWidth: true,
        },
        sequence: {
          actorMargin: 80,
          boxMargin: 12,
          messageMargin: 40,
          mirrorActors: false,
          showSequenceNumbers: true,
          useMaxWidth: true,
        },
        themeVariables: {
          background: '#211f1d',
          primaryColor: '#2a2826',
          primaryBorderColor: '#4a4744',
          primaryTextColor: '#f3f1ee',
          secondaryColor: '#2a2826',
          tertiaryColor: '#2a2826',
          lineColor: '#787470',
          textColor: '#f3f1ee',
          mainBkg: '#2a2826',
          nodeBorder: '#4a4744',
          clusterBkg: '#1d1c1a99',
          clusterBorder: '#3c3936',
          edgeLabelBackground: '#211f1d',
          actorBkg: '#2a2826',
          actorBorder: '#4a4744',
          actorTextColor: '#f3f1ee',
          actorLineColor: '#3c3936',
          signalColor: '#787470',
          signalTextColor: '#c2bfbb',
          labelBoxBkgColor: '#2a2826',
          labelBoxBorderColor: '#52d68e80',
          labelTextColor: '#52d68e',
          loopTextColor: '#52d68e',
          activationBkgColor: '#2a2826',
          activationBorderColor: '#52d68e80',
          noteBkgColor: '#1f2823',
          noteBorderColor: '#52d68e80',
          noteTextColor: '#f3f1ee',
          fontFamily: '"Geist Mono", ui-monospace, monospace',
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
            { label: 'Getting Started', to: '/docs/getting-started/installation' },
            { label: 'Core Concepts', to: '/docs/patterns/events' },
            { label: 'Going to Production', to: '/docs/getting-started/module-configuration' },
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
