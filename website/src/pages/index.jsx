import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import rootPkg from '../../../package.json';
import './landing.css';

const NPM_PACKAGE = '@horizon-republic/nestjs-jetstream';
const INSTALL = `npm i ${NPM_PACKAGE}`;
const FALLBACK_VERSION = rootPkg.version;

const parseNodeMajor = (range) => String(range || '').match(/(\d+)/)?.[1] ?? null;

const NODE_MAJOR = parseNodeMajor(rootPkg.engines?.node);

/** Published version, so the page never claims a release that isn't out. */
const useLiveVersion = (initial) => {
  const [version, setVersion] = useState(initial);

  useEffect(() => {
    let alive = true;

    fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data?.version) setVersion(data.version);
      })
      .catch(() => {
        /* keep the bundled version */
      });

    return () => {
      alive = false;
    };
  }, []);

  return version;
};

const CopyInstall = () => {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(INSTALL).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {
        /* clipboard blocked; the text stays selectable */
      },
    );
  };

  return (
    <button type="button" className="lp-install" onClick={copy} aria-label={`Copy ${INSTALL}`}>
      <span className="lp-install-text">{INSTALL}</span>
      <span className="lp-install-state" aria-live="polite">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
};

const RECORD_FIELDS = [
  { key: 'subject', value: 'orders.created' },
  { key: 'msg-id', value: 'ord_9f21' },
  { key: 'traceparent', value: '00-4bf92f35a8…-01' },
];

const RECORD_LOG = [
  { state: 'deliver', time: '19:04:02.118', event: 'deliver', note: 'attempt 1/5' },
  { state: 'nak', time: '19:04:02.204', event: 'nak', note: 'handler threw · backoff 1s' },
  { state: 'seam', time: '', event: 'pod restart', note: 'in flight, not lost' },
  { state: 'redeliver', time: '19:04:03.336', event: 'redeliver', note: 'attempt 2/5 · new pod' },
  { state: 'ack', time: '19:04:03.402', event: 'ack', note: 'handled in 66 ms' },
];

const DeliveryRecord = () => (
  <figure className="lp-record">
    <div className="lp-record-card">
      <div className="lp-record-head">
        <span className="lp-record-kind">delivery record</span>
        <span className="lp-record-seq">seq 4,832,107</span>
      </div>

      <dl className="lp-record-fields">
        {RECORD_FIELDS.map((field) => (
          <div key={field.key}>
            <dt>{field.key}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>

      <ol className="lp-record-log">
        {RECORD_LOG.map((entry, index) => (
          <li
            key={entry.event}
            data-state={entry.state}
            style={{ '--lp-row': String(index) }}
          >
            <span className="lp-log-time">{entry.time}</span>
            <span className="lp-log-event">{entry.event}</span>
            <span className="lp-log-note">{entry.note}</span>
          </li>
        ))}
      </ol>

      <div className="lp-record-stamp" aria-hidden="true">
        <span>acked</span>
      </div>
    </div>

    <figcaption className="lp-record-caption">
      One message across a deploy that restarts the pod holding it. When the attempts run out
      instead, the message lands in <code>dlq.orders</code> with its headers intact.
    </figcaption>
  </figure>
);

const CodeCard = ({ file, lang, children }) => (
  <div className="lp-code">
    <div className="lp-code-head">
      <span>{file}</span>
      <span>{lang}</span>
    </div>
    <pre className="lp-code-body">{children}</pre>
  </div>
);

const CAPABILITIES = [
  {
    name: 'At-least-once delivery',
    body: 'Every event acked after the handler resolves, with bounded retries and exponential backoff.',
    to: '/docs/patterns/events',
    label: 'patterns/events',
  },
  {
    name: 'Dead-letter queue',
    body: 'A typed sink that keeps the original headers once retries are exhausted, with an onDeadLetter callback.',
    to: '/docs/guides/dead-letter-queue',
    label: 'guides/dead-letter-queue',
  },
  {
    name: 'Ordered delivery',
    body: 'Sequential per partition key, without giving up horizontal scale.',
    to: '/docs/patterns/ordered-events',
    label: 'patterns/ordered-events',
  },
  {
    name: 'Broadcast',
    body: 'One message reaches every running pod through per-service durable consumers.',
    to: '/docs/patterns/broadcast',
    label: 'patterns/broadcast',
  },
  {
    name: 'RPC, both speeds',
    body: 'Core NATS for latency, JetStream for durability, under the same decorator either way.',
    to: '/docs/patterns/rpc',
    label: 'patterns/rpc',
  },
  {
    name: 'Tracing built in',
    body: 'W3C traceparent propagated through every hop, with OpenTelemetry consumer spans out of the box.',
    to: '/docs/observability/tracing',
    label: 'observability/tracing',
  },
];

export default function Home() {
  const version = useLiveVersion(FALLBACK_VERSION);

  useEffect(() => {
    document.body.dataset.page = 'landing';

    return () => {
      delete document.body.dataset.page;
    };
  }, []);

  return (
    <Layout
      title="Messages that survive the deploy"
      description="A NATS JetStream transport for NestJS microservices. The same @EventPattern and @MessagePattern decorators, with durability, bounded retries, dead letters and tracing underneath."
      noFooter
    >
      <main className="landingRoot">
        <section className="lp-hero">
          <div className="lp-hero-lead">
            <h1 className="lp-hero-title">Messages that survive the deploy.</h1>
            <p className="lp-hero-sub">
              A NATS JetStream transport for NestJS microservices. Same <code>@EventPattern</code>,
              same <code>client.emit()</code>, with durability, bounded retries, dead letters and
              tracing underneath.
            </p>

            <div className="lp-actions">
              <CopyInstall />
              <span className="lp-links">
                <Link className="lp-cta" to="/docs/getting-started/quick-start">
                  Quick start
                </Link>
                <Link className="lp-cta lp-cta--quiet" to="/docs/getting-started/why-jetstream">
                  Compare with the built-in transport
                </Link>
              </span>
            </div>

            <span className="lp-facts">
              MIT · v{version} · Node ≥ {NODE_MAJOR} · NestJS 10 to 12 · NATS ≥ 2.10
            </span>
          </div>

          <DeliveryRecord />
        </section>

        <section className="lp-swap">
          <div className="lp-swap-col">
            <h2>The swap is one import.</h2>
            <p>
              The built-in NATS transport is fire and forget: a pod restart loses whatever was
              in flight, and a throw is never retried. This module changes what happens
              underneath the decorators, not the decorators.
            </p>
            <CodeCard file="app.module.ts" lang="ts">
              <span className="c-dim">@Module</span>({'{'}
              {'\n  imports: [\n    '}
              <span className="c-accent">JetstreamModule.forRoot</span>({'{'}
              {'\n      servers: ['}
              <span className="c-str">&apos;nats://localhost:4222&apos;</span>
              {'],\n    }),\n  ],\n'}
              {'})\n'}
              <span className="c-dim">export class</span>
              {' AppModule {}'}
            </CodeCard>
          </div>

          <div className="lp-swap-col">
            <h2>The handler you already wrote.</h2>
            <p>
              Ack after resolve. A throw becomes a <code>nak</code> with exponential backoff, and
              exhausted retries land in a typed dead-letter queue with the original headers
              intact.
            </p>
            <CodeCard file="orders.controller.ts" lang="ts">
              <span className="c-dim">@EventPattern</span>(
              <span className="c-str">&apos;orders.created&apos;</span>){'\n'}
              <span className="c-dim">async</span>
              {' onCreated('}
              <span className="c-dim">@Payload</span>
              {'() order: Order) {\n  '}
              <span className="c-dim">await</span>
              {' this.billing.charge(order);\n  '}
              <span className="c-comment">{'// throws → nak → redelivered with backoff'}</span>
              {'\n}'}
            </CodeCard>
          </div>
        </section>

        <section className="lp-ledger">
          <h2 className="lp-ledger-head">What changes underneath</h2>
          <ul className="lp-ledger-list">
            {CAPABILITIES.map((cap) => (
              <li key={cap.name}>
                <Link to={cap.to} className="lp-ledger-row">
                  <span className="lp-ledger-name">{cap.name}</span>
                  <span className="lp-ledger-body">{cap.body}</span>
                  <span className="lp-ledger-path">{cap.label}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="lp-ledger-note">
            The integration suite executes against a real NATS server, the{' '}
            <a href="https://codecov.io/github/HorizonRepublic/nestjs-jetstream">coverage report</a>{' '}
            is public, the header contract stays stable across minors, and breaking changes land
            only on majors.
          </p>
        </section>

        <footer className="lp-foot">
          <nav className="lp-foot-links" aria-label="Footer">
            <Link to="/docs/">Docs</Link>
            <Link to="/docs/reference/api">API</Link>
            <a href="https://github.com/HorizonRepublic/nestjs-jetstream/releases">Changelog</a>
            <a href="https://github.com/HorizonRepublic/nestjs-jetstream">GitHub</a>
            <a href={`https://www.npmjs.com/package/${NPM_PACKAGE}`}>npm</a>
          </nav>
          <span className="lp-foot-meta">MIT · © 2026 Horizon Republic</span>
        </footer>
      </main>
    </Layout>
  );
}
