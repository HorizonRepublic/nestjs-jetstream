import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const features = [
  {
    label: 'RPC',
    title: 'Request / Reply',
    description:
      'Core NATS for lowest latency, or JetStream for persisted commands. Both modes, one API.',
  },
  {
    label: 'Events',
    title: 'Workqueue Delivery',
    description:
      'At-least-once delivery with automatic retry. Acked on success, redelivered on failure.',
  },
  {
    label: 'Broadcast',
    title: 'Fan-out to All',
    description:
      'Every subscribing service receives every message. Isolated durable consumers per service.',
  },
  {
    label: 'Ordered',
    title: 'Sequential Replay',
    description:
      'Strict ordering for event sourcing and projections. Six deliver policies for any scenario.',
  },
];

function Hero(): React.ReactElement {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <p className={styles.heroMono}>@horizon-republic/nestjs-jetstream</p>
        <h1 className={styles.heroTitle}>
          Ship reliable microservices
          <br />
          <span className={styles.heroAccent}>with NATS JetStream</span>
        </h1>
        <p className={styles.heroTagline}>
          Events, broadcast, ordered delivery, and RPC for NestJS —
          powered by JetStream under the hood.
        </p>
        <div className={styles.heroCta}>
          <Link className={styles.ctaPrimary} to="/docs/">
            Get Started
          </Link>
          <Link
            className={styles.ctaOutline}
            href="https://github.com/HorizonRepublic/nestjs-jetstream"
          >
            View on GitHub
          </Link>
        </div>
      </div>
    </header>
  );
}

function Features(): React.ReactElement {
  return (
    <section className={styles.features}>
      <div className={styles.featuresInner}>
        <div className={styles.featuresGrid}>
          {features.map((f) => (
            <div key={f.label} className={styles.featureCard}>
              <span className={styles.featureLabel}>{f.label}</span>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureDesc}>{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Install(): React.ReactElement {
  return (
    <section className={styles.install}>
      <div className={styles.installInner}>
        <div className={styles.installTerminal}>
          <div className={styles.terminalDots}>
            <span />
            <span />
            <span />
          </div>
          <code className={styles.terminalCode}>
            <span className={styles.terminalPrompt}>$</span>{' '}
            npm install @horizon-republic/nestjs-jetstream
          </code>
        </div>
        <Link className={styles.installCta} to="/docs/">
          Read the Docs &rarr;
        </Link>
      </div>
    </section>
  );
}

export default function Home(): React.ReactElement {
  return (
    <Layout
      title="Home"
      description="Ship reliable microservices with NATS JetStream and NestJS — events, broadcast, ordered delivery, and RPC."
    >
      <Hero />
      <Features />
      <Install />
    </Layout>
  );
}
