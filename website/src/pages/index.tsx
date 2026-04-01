import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const features = [
  {
    icon: '⚡',
    label: 'RPC',
    title: 'Request / Reply',
    description:
      'Core NATS for lowest latency, or JetStream for persisted commands. Both modes, one API.',
    color: 'cyan',
  },
  {
    icon: '📨',
    label: 'Events',
    title: 'Workqueue Delivery',
    description:
      'At-least-once delivery with automatic retry. Acked on success, redelivered on failure.',
    color: 'blue',
  },
  {
    icon: '📡',
    label: 'Broadcast',
    title: 'Fan-out to All',
    description:
      'Every subscribing service receives every message. Isolated durable consumers per service.',
    color: 'violet',
  },
  {
    icon: '📋',
    label: 'Ordered',
    title: 'Sequential Replay',
    description:
      'Strict ordering for event sourcing and projections. Six deliver policies for any scenario.',
    color: 'emerald',
  },
];

const highlights = [
  {
    icon: '🛡️',
    title: 'Self-Healing Consumers',
    description: 'Exponential backoff reconnection. Your consumers recover from any transient failure automatically.',
  },
  {
    icon: '💀',
    title: 'Dead Letter Queue',
    description: 'Failed messages are captured with full context. Debug with payload, headers, and error details.',
  },
  {
    icon: '⏰',
    title: 'Message Scheduling',
    description: 'Delayed delivery powered by NATS 2.12. Schedule messages for future processing without external tools.',
  },
  {
    icon: '🔍',
    title: 'Health Checks',
    description: 'Built-in Terminus-free health indicator. Connection + stream + consumer health in one call.',
  },
  {
    icon: '🔄',
    title: 'Lifecycle Hooks',
    description: 'React to connect, disconnect, reconnect, and dead-letter events with typed hook handlers.',
  },
  {
    icon: '🚀',
    title: 'Zero Config Defaults',
    description: 'Production-ready stream and consumer configs out of the box. Override only what you need.',
  },
];

function Hero(): React.ReactElement {
  return (
    <header className={styles.hero}>
      <div className={styles.heroGlow} aria-hidden="true" />
      <div className={styles.heroGrid} aria-hidden="true" />
      <div className={styles.heroInner}>
        <div className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} />
          Open Source &middot; MIT License
        </div>
        <h1 className={styles.heroTitle}>
          Ship reliable microservices
          <br />
          <span className={styles.heroAccent}>with NATS JetStream</span>
        </h1>
        <p className={styles.heroTagline}>
          Production-grade NestJS transport for NATS JetStream.
          Events, broadcast, ordered delivery, and RPC — all in one package.
        </p>
        <div className={styles.heroCta}>
          <Link className={styles.ctaPrimary} to="/docs/">
            Get Started
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
          <Link
            className={styles.ctaSecondary}
            href="https://github.com/HorizonRepublic/nestjs-jetstream"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub
          </Link>
        </div>
        <div className={styles.heroInstall}>
          <code className={styles.heroInstallCode}>
            <span className={styles.heroInstallPrompt}>$</span>
            {' npm i @horizon-republic/nestjs-jetstream'}
          </code>
        </div>
      </div>
    </header>
  );
}

function Features(): React.ReactElement {
  return (
    <section className={styles.features}>
      <div className={styles.sectionInner}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTag}>Messaging Patterns</span>
          <h2 className={styles.sectionTitle}>Four patterns, one transport</h2>
          <p className={styles.sectionDesc}>
            Every messaging pattern you need for microservices — built on NATS JetStream
            with NestJS decorators you already know.
          </p>
        </div>
        <div className={styles.featuresGrid}>
          {features.map((f) => (
            <div key={f.label} className={`${styles.featureCard} ${styles[`featureCard--${f.color}`]}`}>
              <div className={styles.featureIcon} aria-hidden="true">{f.icon}</div>
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

function Highlights(): React.ReactElement {
  return (
    <section className={styles.highlights}>
      <div className={styles.sectionInner}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTag}>Built-in Features</span>
          <h2 className={styles.sectionTitle}>Everything you need, nothing you don't</h2>
          <p className={styles.sectionDesc}>
            Production-ready features included. No extra packages, no boilerplate.
          </p>
        </div>
        <div className={styles.highlightsGrid}>
          {highlights.map((h) => (
            <div key={h.title} className={styles.highlightCard}>
              <span className={styles.highlightIcon} aria-hidden="true">{h.icon}</span>
              <h3 className={styles.highlightTitle}>{h.title}</h3>
              <p className={styles.highlightDesc}>{h.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CodePreview(): React.ReactElement {
  return (
    <section className={styles.codePreview}>
      <div className={styles.sectionInner}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTag}>Quick Start</span>
          <h2 className={styles.sectionTitle}>Five minutes to your first event</h2>
          <p className={styles.sectionDesc}>
            Familiar NestJS patterns. If you've used <code>@nestjs/microservices</code>, you already know this.
          </p>
        </div>
        <div className={styles.codeGrid}>
          <div className={styles.codeBlock}>
            <div className={styles.codeBlockHeader}>
              <div className={styles.codeBlockDots} aria-hidden="true">
                <span /><span /><span />
              </div>
              <span className={styles.codeBlockFile}>publisher.service.ts</span>
            </div>
            <pre className={styles.codeBlockPre}>
              <code>{`import { JetstreamRecordBuilder }
  from '@horizon-republic/nestjs-jetstream';

// Publish an event
const record = new JetstreamRecordBuilder({
  orderId: '42',
  status: 'created',
}).build();

await lastValueFrom(
  this.client.emit('order.created', record)
);`}</code>
            </pre>
          </div>
          <div className={styles.codeBlock}>
            <div className={styles.codeBlockHeader}>
              <div className={styles.codeBlockDots} aria-hidden="true">
                <span /><span /><span />
              </div>
              <span className={styles.codeBlockFile}>handler.controller.ts</span>
            </div>
            <pre className={styles.codeBlockPre}>
              <code>{`import { EventPattern, Payload }
  from '@nestjs/microservices';

@EventPattern('order.created')
handleOrderCreated(
  @Payload() data: OrderCreatedDto
) {
  // At-least-once delivery
  // Auto-ack on success, redelivery on error
  return this.ordersService.process(data);
}`}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function BottomCta(): React.ReactElement {
  return (
    <section className={styles.bottomCta}>
      <div className={styles.bottomCtaGlow} aria-hidden="true" />
      <div className={styles.sectionInner}>
        <h2 className={styles.bottomCtaTitle}>Ready to build?</h2>
        <p className={styles.bottomCtaDesc}>
          Get started in minutes. Production-ready defaults, zero boilerplate.
        </p>
        <div className={styles.heroCta}>
          <Link className={styles.ctaPrimary} to="/docs/">
            Read the Docs
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
          <Link
            className={styles.ctaSecondary}
            href="https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream"
            target="_blank"
            rel="noopener noreferrer"
          >
            View on npm
          </Link>
        </div>
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
      <Highlights />
      <CodePreview />
      <BottomCta />
    </Layout>
  );
}
