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
  { state: 'deliver', time: '19:04:02.118', event: 'deliver', note: 'attempt 1/3' },
  { state: 'nak', time: '19:04:02.204', event: 'nak', note: 'handler threw · retry in 2 s' },
  { state: 'seam', time: '', event: 'pod restart', note: 'in flight, not lost' },
  { state: 'redeliver', time: '19:04:04.336', event: 'redeliver', note: 'attempt 2/3 · new pod' },
  { state: 'ack', time: '19:04:04.402', event: 'ack', note: 'handled in 66 ms' },
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

      <div className="lp-record-life" aria-hidden="true">
        {RECORD_LOG.map((entry) => (
          <span key={entry.event} data-state={entry.state} />
        ))}
      </div>

      <ol className="lp-record-log">
        {RECORD_LOG.map((entry, index) => (
          <li
            key={entry.event}
            data-state={entry.state}
            style={{ '--lp-row': String(index) }}
          >
            <span className="lp-log-time">{entry.time}</span>
            <span className="lp-log-event">
              <span className="lp-log-pill">{entry.event}</span>
            </span>
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
      instead, the message lands in <code>orders__microservice_dlq-stream</code> with its headers
      intact.
    </figcaption>
  </figure>
);

const DIFF = [
  { kind: 'del', text: "import { ClientsModule, Transport } from '@nestjs/microservices';" },
  { kind: 'add', text: "import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';" },
  { kind: 'same', text: '' },
  { kind: 'same', text: '@Module({' },
  { kind: 'same', text: '  imports: [' },
  { kind: 'del', text: "    ClientsModule.register([{ name: 'ORDERS', transport: Transport.NATS }])," },
  { kind: 'add', text: "    JetstreamModule.forRoot({ name: 'orders', servers }),", },
  { kind: 'add', text: "    JetstreamModule.forFeature({ name: 'orders' })," },
  { kind: 'same', text: '  ],' },
  { kind: 'same', text: '})' },
  { kind: 'same', text: 'export class AppModule {}' },
];

const DIFF_MARK = { add: '+', del: '-', same: ' ' };

const SwapDiff = () => (
  <figure className="lp-diff">
    <div className="lp-diff-head">
      <span>app.module.ts</span>
      <span className="lp-diff-stat">
        <span data-kind="add">+3</span> <span data-kind="del">-2</span>
      </span>
    </div>
    <pre className="lp-diff-body">
      {DIFF.map((line, index) => (
        <span key={index} className="lp-diff-line" data-kind={line.kind}>
          <span className="lp-diff-mark" aria-hidden="true">
            {DIFF_MARK[line.kind]}
          </span>
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  </figure>
);

const FLOW = [
  { state: 'deliver', name: 'publish', body: 'client.emit() stores the message in the stream before it returns.' },
  { state: 'deliver', name: 'deliver', body: 'One replica pulls it. If that pod dies mid-handler, another replica gets it.' },
  { state: 'redeliver', name: 'nak', body: 'The handler threw. It comes back in 2 s, then in 10 s.' },
  { state: 'ack', name: 'ack', body: 'The handler resolved. The message leaves the stream.' },
];

const MessageFlow = () => (
  <div className="lp-flow">
    <ol className="lp-flow-steps">
      {FLOW.map((step) => (
        <li key={step.name} data-state={step.state}>
          <span className="lp-flow-name">{step.name}</span>
          <span className="lp-flow-body">{step.body}</span>
        </li>
      ))}
    </ol>
    <div className="lp-flow-branch" data-state="dlq">
      <span className="lp-flow-name">dead letter</span>
      <span className="lp-flow-body">
        The third attempt failed too. The message is copied to the DLQ stream with its headers,
        and <code>onDeadLetter</code> is called. Nothing is dropped silently.
      </span>
    </div>
  </div>
);

const GROUPS = [
  {
    name: 'Deliver',
    tone: 'deliver',
    items: [
      { name: 'Workqueue events', body: 'One replica per message, at least once.', to: '/docs/patterns/events' },
      { name: 'Broadcast', body: 'Every service gets every message.', to: '/docs/patterns/broadcast' },
      { name: 'Ordered events', body: 'A strict, replayable sequence per replica.', to: '/docs/patterns/ordered-events' },
      { name: 'RPC', body: 'Core NATS for latency, JetStream for durability.', to: '/docs/patterns/rpc' },
    ],
  },
  {
    name: 'Recover',
    tone: 'redeliver',
    items: [
      { name: 'Paced retries', body: 'A throw retries on a delay curve, not in a hot loop.', to: '/docs/patterns/events#delivery-semantics' },
      { name: 'Dead-letter stream', body: 'Exhausted messages kept with their headers.', to: '/docs/guides/dead-letter-queue' },
      { name: 'Self-healing consumers', body: 'Recreated after a broker restart or a deletion.', to: '/docs/reference/edge-cases#consumer-self-healing' },
      { name: 'Stream migration', body: 'Change a locked stream setting without losing messages.', to: '/docs/guides/stream-migration' },
    ],
  },
  {
    name: 'Run',
    tone: 'ack',
    items: [
      { name: 'Cron and delayed jobs', body: 'Fired by NATS itself, no scheduler process.', to: '/docs/guides/scheduling-overview' },
      { name: 'Tracing and metrics', body: 'OpenTelemetry spans and Prometheus metrics.', to: '/docs/observability' },
      { name: 'Health checks', body: 'Readiness and liveness for Kubernetes probes.', to: '/docs/guides/health-checks' },
      { name: 'Graceful shutdown', body: 'In-flight handlers drain before the pod exits.', to: '/docs/guides/graceful-shutdown' },
    ],
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
                <Link className="lp-cta lp-cta--solid" to="/docs/getting-started/quick-start">
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

        <section className="lp-band lp-swap">
          <div className="lp-wrap lp-swap-grid">
            <div className="lp-swap-copy">
              <h2>The swap is one import.</h2>
              <p>
                Your <code>@EventPattern</code> and <code>@MessagePattern</code> handlers stay as
                they are, and so does <code>client.emit()</code>. What changes is what happens
                underneath them.
              </p>
            </div>
            <SwapDiff />
          </div>
        </section>

        <section className="lp-band lp-band--raised">
          <div className="lp-wrap">
            <h2 className="lp-section-title">Where a message goes when a handler fails.</h2>
            <MessageFlow />
          </div>
        </section>

        <section className="lp-band">
          <div className="lp-wrap">
            <h2 className="lp-section-title">What you get underneath the decorators.</h2>
            <div className="lp-groups">
              {GROUPS.map((group) => (
                <section key={group.name} className="lp-group" data-tone={group.tone}>
                  <h3 className="lp-group-name">{group.name}</h3>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.name}>
                        <Link to={item.to} className="lp-group-item">
                          <span className="lp-group-item-name">{item.name}</span>
                          <span className="lp-group-item-body">{item.body}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-band lp-band--raised lp-close">
          <div className="lp-wrap lp-close-inner">
            <h2>Start with one service.</h2>
            <div className="lp-actions">
              <CopyInstall />
              <Link className="lp-cta lp-cta--solid" to="/docs/getting-started/quick-start">
                Quick start
              </Link>
              <Link className="lp-cta lp-cta--quiet" to="/docs/guides/migration">
                Migrate from the built-in transport
              </Link>
            </div>
            <p className="lp-close-note">
              The integration suite runs against a real NATS server, the{' '}
              <a href="https://codecov.io/github/HorizonRepublic/nestjs-jetstream">coverage report</a>{' '}
              is public, and breaking changes land only on majors.
            </p>
          </div>
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
