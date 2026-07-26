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

/** The published version, so the page never claims a release that isn't out. */
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

/**
 * The signature: one message's life, end to end. Publish, a failed attempt, a
 * pod restart it survives, redelivery on a new pod, ack. Every colour used
 * anywhere on the site is defined by what it means here.
 */
const DeliveryRecord = () => (
  <figure className="lp-record">
    <div className="lp-record-trace" aria-hidden="true">
      <span>traceparent: 00-4bf92f35…-01 · one trace, every hop</span>
    </div>

    <ol className="lp-record-track">
      <li className="lp-step" data-state="publish">
        <span className="lp-step-mark" aria-hidden="true" />
        <span className="lp-step-label">publish</span>
        <span className="lp-step-meta">
          orders.created
          <br />
          Nats-Msg-Id: ord_9f21
        </span>
      </li>

      <li className="lp-step" data-state="deliver">
        <span className="lp-step-mark" aria-hidden="true" />
        <span className="lp-step-label">deliver #1</span>
        <span className="lp-step-meta">attempt 1/5</span>
      </li>

      <li className="lp-step" data-state="throw">
        <span className="lp-step-mark" aria-hidden="true" />
        <span className="lp-step-label">handler throws</span>
        <span className="lp-step-meta">nak · backoff 1s</span>
      </li>

      <li className="lp-step lp-step--restart" data-state="restart">
        <span className="lp-step-mark" aria-hidden="true" />
        <span className="lp-step-label">pod restart</span>
        <span className="lp-step-meta">in flight, not lost</span>
      </li>

      <li className="lp-step" data-state="redeliver">
        <span className="lp-step-mark" aria-hidden="true" />
        <span className="lp-step-label">redeliver #2</span>
        <span className="lp-step-meta">attempt 2/5 · new pod</span>
      </li>

      <li className="lp-step" data-state="ack">
        <span className="lp-step-mark" aria-hidden="true" />
        <span className="lp-step-label">ack</span>
        <span className="lp-step-meta">seq 4,832,107</span>
      </li>
    </ol>

    <figcaption className="lp-record-caption">
      One message, from publish to ack, across a deploy that restarts the pod holding it.
      Attempts run out and the message is routed to <code>dlq.orders</code>, headers intact.
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
          <h1 className="lp-hero-title">Messages that survive the deploy.</h1>
          <p className="lp-hero-sub">
            A NATS JetStream transport for NestJS microservices. Same <code>@EventPattern</code>,
            same <code>client.emit()</code>, with durability, bounded retries, dead letters and
            tracing underneath.
          </p>
        </section>

        <section className="lp-signature">
          <DeliveryRecord />

          <div className="lp-actions">
            <CopyInstall />
            <Link className="lp-cta" to="/docs/getting-started/quick-start">
              Quick start
            </Link>
            <Link className="lp-cta lp-cta--quiet" to="/docs/getting-started/why-jetstream">
              Why JetStream, honestly
            </Link>
            <span className="lp-facts">
              MIT · v{version} · Node ≥ {NODE_MAJOR} · NestJS 10 to 12 · NATS ≥ 2.10
            </span>
          </div>
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
