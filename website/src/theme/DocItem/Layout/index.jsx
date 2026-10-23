import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import { useSidebarBreadcrumbs } from '@docusaurus/plugin-content-docs/client';

/* Each sidebar section has a tone; the page carries it so the stylesheet can
   colour the active sidebar link, the lede and the heading marks to match. */
const TONES = {
  Start: 'deliver',
  'Delivery patterns': 'deliver',
  'Messages and handlers': 'violet',
  Scheduling: 'amber',
  Reliability: 'green',
  Infrastructure: 'teal',
  Observability: 'rose',
  Troubleshooting: 'red',
};

export default function LayoutWrapper(props) {
  const crumbs = useSidebarBreadcrumbs();
  const section = crumbs?.[0]?.label;

  return (
    <div className="jt-doc" data-tone={TONES[section] ?? 'neutral'}>
      <Layout {...props} />
    </div>
  );
}
