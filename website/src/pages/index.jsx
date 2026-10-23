import React, { useEffect, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import HeroScene from '../components/SystemSim';
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

const GITHUB_PATH =
  'M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.37-.93-.9-1.18-.9-1.18-.73-.5.06-.49.06-.49.81.06 1.24.83 1.24.83.72 1.23 1.88.88 2.34.67.07-.52.28-.88.5-1.08-1.78-.2-3.65-.89-3.65-3.96 0-.88.31-1.6.83-2.16-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.83a7.7 7.7 0 0 1 4 0c1.53-1.04 2.2-.83 2.2-.83.44 1.11.16 1.93.08 2.13.52.56.83 1.28.83 2.16 0 3.08-1.88 3.76-3.66 3.96.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z';

const GitHubMark = () => (
  <svg className="lp-btn-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d={GITHUB_PATH} />
  </svg>
);

const BuiltFor = () => {
  const nest = useBaseUrl('/img/brands/nestjs.svg');
  const nats = useBaseUrl('/img/brands/nats.svg');

  return (
    <p className="lp-built">
      <span>
        <img src={nest} alt="" width="18" height="18" />
        Built for NestJS
      </span>
      <span>
        <img src={nats} alt="" width="18" height="18" />
        Runs on NATS JetStream
      </span>
    </p>
  );
};

const Icon = ({ children }) => (
  <svg
    className="lp-icon"
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const ICONS = {
  persist: (
    <Icon>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </Icon>
  ),
  retry: (
    <Icon>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v4.5h-4.5" />
    </Icon>
  ),
  api: (
    <Icon>
      <path d="M8 7 3 12l5 5" />
      <path d="m16 7 5 5-5 5" />
    </Icon>
  ),
  events: (
    <Icon>
      <path d="M4 12h12" />
      <path d="m12 7 5 5-5 5" />
      <path d="M20 5v14" />
    </Icon>
  ),
  rpc: (
    <Icon>
      <path d="M4 8h14l-3-3" />
      <path d="M20 16H6l3 3" />
    </Icon>
  ),
  broadcast: (
    <Icon>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" />
      <path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
    </Icon>
  ),
  ordered: (
    <Icon>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 5h1.5v3M4 11.5h2l-2 2.5h2M4 17h2v3H4" />
    </Icon>
  ),
  dlq: (
    <Icon>
      <path d="M3 13h5l1.5 3h5l1.5-3h5" />
      <path d="M5.5 5h13L21 13v6H3v-6z" />
    </Icon>
  ),
  schedule: (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  ),
  observe: (
    <Icon>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </Icon>
  ),
  health: (
    <Icon>
      <path d="M12 3 4.5 6v5.5c0 4.4 3.1 8 7.5 9.5 4.4-1.5 7.5-5.1 7.5-9.5V6z" />
      <path d="m8.8 12 2.2 2.2 4.2-4.4" />
    </Icon>
  ),
  clusters: (
    <Icon>
      <circle cx="6" cy="17" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <circle cx="12" cy="6" r="2.5" />
      <path d="M8 15.5 10.6 8M16 15.5 13.4 8M8.5 17h7" />
    </Icon>
  ),
};

const REASONS = [
  {
    icon: 'persist',
    tone: 'deliver',
    title: 'Nothing lost on deploy',
    body: 'A message stays in a JetStream stream until a handler acks it. If the pod restarts mid-handler, another replica picks the message up.',
  },
  {
    icon: 'retry',
    tone: 'redeliver',
    title: 'Failures have somewhere to go',
    body: 'A throw retries after 2 s, then 10 s. A message that still fails is kept in a dead-letter stream with its headers, never dropped.',
  },
  {
    icon: 'api',
    tone: 'ack',
    title: 'The NestJS API you already use',
    body: 'Handlers, ClientProxy and exception filters stay as they are. What changes is the module you import.',
  },
];

const COMPARISON = [
  { row: '@EventPattern, @MessagePattern and ClientProxy', builtin: true, ours: true },
  { row: 'Low-latency request and reply', builtin: true, ours: true },
  { row: 'Messages survive a restart', builtin: false, ours: true },
  { row: 'Retries when a handler throws', builtin: false, ours: true },
  { row: 'Dead-letter stream', builtin: false, ours: true },
  { row: 'Broadcast with catch-up for late replicas', builtin: false, ours: true },
  { row: 'Replay of past events', builtin: false, ours: true },
  { row: 'Cron and delayed delivery', builtin: false, ours: true },
  { row: 'OpenTelemetry tracing and Prometheus metrics', builtin: false, ours: true },
];

const Check = ({ value }) =>
  value ? (
    <span className="lp-yes" aria-label="yes">
      ✓
    </span>
  ) : (
    <span className="lp-no" aria-label="no">
      –
    </span>
  );

const DIFF = [
  { kind: 'del', text: "ClientsModule.register([{ name: 'ORDERS', transport: Transport.NATS }])," },
  { kind: 'add', text: "JetstreamModule.forRoot({ name: 'orders', servers })," },
  { kind: 'add', text: "JetstreamModule.forFeature({ name: 'orders' })," },
];

const DIFF_MARK = { add: '+', del: '-' };

const STEPS = [
  { title: 'Install the package', body: 'The NATS client comes with it.' },
  { title: 'Swap the module', body: 'forRoot for the service, forFeature for each target it calls.' },
  { title: 'Connect the transport', body: 'One connectMicroservice call in main.ts.' },
  { title: 'Keep your handlers', body: 'Make them idempotent: delivery is now at least once.' },
];

const FEATURES = [
  { icon: 'events', tone: 'deliver', name: 'Workqueue events', body: 'Each message reaches one replica, at least once.', to: '/docs/patterns/events' },
  { icon: 'rpc', tone: 'deliver', name: 'RPC', body: 'Core NATS for latency or JetStream for durability, per module.', to: '/docs/patterns/rpc' },
  { icon: 'broadcast', tone: 'deliver', name: 'Broadcast', body: 'Every service gets every message, late replicas included.', to: '/docs/patterns/broadcast' },
  { icon: 'ordered', tone: 'deliver', name: 'Ordered events', body: 'A strict, replayable sequence for projections and caches.', to: '/docs/patterns/ordered-events' },
  { icon: 'dlq', tone: 'dlq', name: 'Dead-letter queue', body: 'Exhausted messages kept with headers and delivery count.', to: '/docs/guides/dead-letter-queue' },
  { icon: 'schedule', tone: 'redeliver', name: 'Cron and delayed jobs', body: 'Fired by NATS itself, with no scheduler process to run.', to: '/docs/guides/scheduling-overview' },
  { icon: 'observe', tone: 'trace', name: 'Tracing and metrics', body: 'W3C trace context across hops, Prometheus metrics built in.', to: '/docs/observability' },
  { icon: 'health', tone: 'ack', name: 'Health and shutdown', body: 'Kubernetes probes, and in-flight work drained on SIGTERM.', to: '/docs/guides/health-checks' },
  { icon: 'clusters', tone: 'trace', name: 'Multiple clusters', body: 'One service talking to several NATS clusters at once.', to: '/docs/guides/multi-connection' },
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
      title="Durable messaging for NestJS microservices"
      description="A NATS JetStream transport for NestJS microservices. The same @EventPattern and @MessagePattern decorators, with durability, bounded retries, dead letters and tracing underneath."
    >
      <main className="landingRoot">
        <section className="lp-hero">
          <HeroScene />
          <div className="lp-container lp-hero-grid">
            <div className="lp-hero-lead">
              <h1 className="lp-hero-title">Durable messaging for NestJS microservices</h1>
              <p className="lp-hero-sub">
                A NestJS transport for NATS JetStream. Keep <code>@EventPattern</code>,{' '}
                <code>@MessagePattern</code> and <code>ClientProxy</code> as they are: messages
                persist across deploys, failed handlers retry, and what still fails is kept for
                you to inspect.
              </p>

              <div className="lp-buttons">
                <Link className="lp-btn lp-btn--primary" to="/docs/getting-started/quick-start">
                  Get started
                </Link>
                <Link className="lp-btn lp-btn--secondary" to="/docs/getting-started/why-jetstream">
                  Why JetStream
                </Link>
              </div>

              <CopyInstall />

              <BuiltFor />

              <ul className="lp-badges" aria-label="Compatibility">
                <li>v{version}</li>
                <li>NestJS 10, 11, 12</li>
                <li>NATS ≥ 2.10</li>
                <li>Node ≥ {NODE_MAJOR}</li>
                <li>MIT</li>
              </ul>
            </div>

            <div className="lp-hero-room" aria-hidden="true" />
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-container">
            <div className="lp-reasons">
              {REASONS.map((reason) => (
                <div key={reason.title} className="lp-reason" data-tone={reason.tone}>
                  <span className="lp-reason-icon">{ICONS[reason.icon]}</span>
                  <h2>{reason.title}</h2>
                  <p>{reason.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section lp-section--alt">
          <div className="lp-container lp-split">
            <div className="lp-split-copy">
              <h2 className="lp-h2">When the built-in transport is not enough</h2>
              <p>
                NestJS ships a NATS transport on Core NATS: fast, and fire and forget. It suits
                cache invalidations and other messages you can afford to lose. For work that must
                happen, this library adds what Core NATS leaves out.
              </p>
              <Link className="lp-more" to="/docs/getting-started/why-jetstream">
                Read the full comparison
              </Link>
            </div>

            <div className="lp-table-wrap">
              <table className="lp-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="lp-visually-hidden">Capability</span>
                    </th>
                    <th scope="col">Transport.NATS</th>
                    <th scope="col">nestjs-jetstream</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map((item) => (
                    <tr key={item.row}>
                      <th scope="row">{item.row}</th>
                      <td>
                        <Check value={item.builtin} />
                      </td>
                      <td>
                        <Check value={item.ours} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-container lp-split lp-split--code">
            <div className="lp-split-copy">
              <h2 className="lp-h2">Switching is a module swap</h2>
              <ol className="lp-steps">
                {STEPS.map((step) => (
                  <li key={step.title}>
                    <strong>{step.title}.</strong> {step.body}
                  </li>
                ))}
              </ol>
              <Link className="lp-more" to="/docs/guides/migration">
                Migration guide
              </Link>
            </div>

            <figure className="lp-diff">
              <figcaption className="lp-diff-head">
                <span>app.module.ts</span>
                <span>
                  <span className="lp-diff-add">+2</span> <span className="lp-diff-del">-1</span>
                </span>
              </figcaption>
              <pre className="lp-diff-body">
                {DIFF.map((line) => (
                  <span key={line.text} className="lp-diff-line" data-kind={line.kind}>
                    <span className="lp-diff-mark" aria-hidden="true">
                      {DIFF_MARK[line.kind]}
                    </span>
                    {line.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </figure>
          </div>
        </section>

        <section className="lp-section lp-section--alt">
          <div className="lp-container">
            <h2 className="lp-h2 lp-h2--center">What is in the box</h2>
            <ul className="lp-features">
              {FEATURES.map((feature) => (
                <li key={feature.name}>
                  <Link to={feature.to} className="lp-feature" data-tone={feature.tone}>
                    <span className="lp-feature-icon">{ICONS[feature.icon]}</span>
                    <span className="lp-feature-name">{feature.name}</span>
                    <span className="lp-feature-body">{feature.body}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lp-section lp-cta-band">
          <div className="lp-container lp-cta-inner">
            <div>
              <h2 className="lp-h2">Run your first durable handler</h2>
              <p>The quick start takes about five minutes against a local NATS in Docker.</p>
            </div>
            <div className="lp-buttons">
              <Link className="lp-btn lp-btn--primary" to="/docs/getting-started/quick-start">
                Get started
              </Link>
              <a className="lp-btn lp-btn--secondary" href="https://github.com/HorizonRepublic/nestjs-jetstream">
                <GitHubMark />
                GitHub
              </a>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
