import React from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme-original/DocItem/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { useDoc, useSidebarBreadcrumbs } from '@docusaurus/plugin-content-docs/client';
import { toneOf } from '@site/src/theme/sectionTones';

export default function LayoutWrapper(props) {
  const crumbs = useSidebarBreadcrumbs();
  const { metadata } = useDoc();
  // a preview image per page, generated at build time by scripts/og/generate.mjs
  const image = useBaseUrl(`/img/og/${metadata.id}.png`, { absolute: true });

  return (
    <div className="jt-doc" data-tone={toneOf(crumbs?.[0]?.label)}>
      <Head>
        <meta property="og:image" content={image} />
        <meta name="twitter:image" content={image} />
      </Head>
      <Layout {...props} />
    </div>
  );
}
