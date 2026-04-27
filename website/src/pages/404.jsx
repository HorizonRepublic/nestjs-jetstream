import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './404.module.css';

export default function NotFound() {
  return (
    <Layout title="Page not found" description="The page you're looking for doesn't exist.">
      <main className={styles.root}>
        <div className={styles.inner}>
          <p className={styles.eyebrow}>404 · NOT FOUND</p>
          <h1 className={styles.title}>This page doesn't exist.</h1>
          <p className={styles.lede}>
            Maybe it moved, maybe it was never here. Pick where you'd like to go next.
          </p>
          <div className={styles.actions}>
            <Link className={styles.btnPrimary} to="/docs/">
              Open the docs
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </Link>
            <Link className={styles.btnSecondary} to="/docs/getting-started/quick-start">
              Quick Start
            </Link>
          </div>
          <ul className={styles.shortcuts}>
            <li><Link to="/docs/getting-started/why-jetstream">Why JetStream?</Link></li>
            <li><Link to="/docs/patterns/events">Events</Link></li>
            <li><Link to="/docs/patterns/rpc">RPC</Link></li>
            <li><Link to="/docs/patterns/broadcast">Broadcast</Link></li>
            <li><Link to="/docs/reference/api">API Reference</Link></li>
          </ul>
        </div>
      </main>
    </Layout>
  );
}
