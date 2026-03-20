import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const features = [
  {
    icon: '\u21C4',
    title: 'RPC (Request/Reply)',
    description:
      'Core NATS for lowest latency, or JetStream for persisted commands. Both modes, one API.',
  },
  {
    icon: '\u2693',
    title: 'Workqueue Events',
    description:
      'At-least-once delivery with automatic retry. Messages acked after handler success, redelivered on failure.',
  },
  {
    icon: '\u269B',
    title: 'Broadcast Events',
    description:
      'Fan-out to all services. Each subscriber gets its own durable consumer with isolated delivery tracking.',
  },
  {
    icon: '\u2191',
    title: 'Ordered Events',
    description:
      'Strict sequential delivery for event sourcing and projections. Six deliver policies for any replay scenario.',
  },
];

function Hero(): React.ReactElement {
  return (
    <header className={styles.hero}>
      <h1 className={styles.heroTitle}>
        NestJS Transport for NATS&nbsp;JetStream
      </h1>
      <p className={styles.heroTagline}>
        Production-grade events, broadcast, ordered delivery, and RPC — with
        two lines of config
      </p>
      <div className={styles.heroCta}>
        <Link className={styles.ctaPrimary} to="/docs/">
          Get Started
        </Link>
        <Link
          className={styles.ctaOutline}
          href="https://github.com/HorizonRepublic/nestjs-jetstream"
        >
          GitHub
        </Link>
      </div>
    </header>
  );
}

function Features(): React.ReactElement {
  return (
    <section className={styles.features}>
      <div className={styles.featuresInner}>
        <h2 className={styles.featuresHeading}>Messaging Patterns</h2>
        <p className={styles.featuresSubheading}>
          Four patterns that cover every NestJS messaging need
        </p>
        <div className={styles.featuresGrid}>
          {features.map((f) => (
            <div key={f.title} className={styles.featureCard}>
              <div className={styles.featureIcon}>{f.icon}</div>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureDesc}>{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Bottom(): React.ReactElement {
  return (
    <section className={styles.bottom}>
      <h2 className={styles.bottomHeading}>Get Started in 5 Minutes</h2>
      <div className={styles.installBlock}>
        npm install @horizon-republic/nestjs-jetstream
      </div>
      <br />
      <Link className={styles.bottomCta} to="/docs/">
        Read the Docs
      </Link>
    </section>
  );
}

export default function Home(): React.ReactElement {
  return (
    <Layout
      title="Home"
      description="Production-grade NestJS transport for NATS JetStream — events, broadcast, ordered delivery, and RPC."
    >
      <Hero />
      <Features />
      <Bottom />
    </Layout>
  );
}
