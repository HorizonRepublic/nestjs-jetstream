import React, { useEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
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
      One message across a deploy that restarts the pod holding it.
    </figcaption>
  </figure>
);

/* One message's life on a loop: emitted, stored, failed once, retried after the
   delay, acked. The phase drives colours in CSS; motion drives the movement. */
const TRACK_STOPS = { emit: 0.1, stream: 0.5, handler: 0.9 };
const GLIDE = { duration: 1.1, ease: [0.45, 0, 0.2, 1] };

const MessageTrack = () => {
  const ref = useRef(null);
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState('idle');
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const opacity = useMotionValue(0);
  const scale = useMotionValue(1);
  const ring = useMotionValue(0);

  useEffect(() => {
    if (reduceMotion) return undefined;

    let alive = true;
    const at = (stop) => (ref.current?.clientWidth ?? 0) * TRACK_STOPS[stop];
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const loop = async () => {
      await pause(900);

      while (alive) {
        setPhase('idle');
        x.set(at('emit'));
        y.set(0);
        scale.set(1);
        ring.set(0);
        await animate(opacity, 1, { duration: 0.4 });
        await animate(x, at('stream'), GLIDE);
        if (!alive) return;
        setPhase('stored');
        await pause(700);
        setPhase('flight');
        await animate(x, at('handler'), GLIDE);
        if (!alive) return;
        setPhase('nak');
        await pause(900);
        await Promise.all([
          animate(x, at('stream'), { duration: 1.2, ease: [0.45, 0, 0.2, 1] }),
          animate(y, [0, 22, 0], { duration: 1.2, ease: 'easeInOut' }),
        ]);
        if (!alive) return;
        setPhase('waiting');
        await animate(ring, 1, { duration: 2, ease: 'linear' });
        setPhase('flight');
        await animate(x, at('handler'), GLIDE);
        if (!alive) return;
        setPhase('ack');
        await Promise.all([
          animate(scale, 1.9, { duration: 1.1, ease: 'easeOut' }),
          animate(opacity, 0, { duration: 0.8, delay: 0.5 }),
        ]);
        await pause(2600);
      }
    };

    void loop();

    return () => {
      alive = false;
    };
  }, [reduceMotion, x, y, opacity, scale, ring]);

  return (
    <div className="lp-track" ref={ref} data-phase={phase} aria-hidden="true">
      <svg className="lp-track-svg" viewBox="0 0 100 64" preserveAspectRatio="none">
        <line x1="4" y1="20" x2="96" y2="20" />
        <path className="lp-track-arc" d="M90 20 Q70 64 50 20" />
      </svg>

      <div className="lp-track-node" data-node="emit">
        <span className="lp-track-point" />
        <span className="lp-track-label">client.emit()</span>
      </div>
      <div className="lp-track-node" data-node="stream">
        <svg className="lp-track-ring" viewBox="0 0 30 30">
          <motion.circle cx="15" cy="15" r="13" style={{ pathLength: ring }} />
        </svg>
        <span className="lp-track-point" />
        <span className="lp-track-label">stream</span>
      </div>
      <div className="lp-track-node" data-node="handler">
        <span className="lp-track-status" data-status="nak">
          nak · retry in 2 s
        </span>
        <span className="lp-track-status" data-status="ack">
          ack
        </span>
        <span className="lp-track-point" />
        <span className="lp-track-label">handler</span>
      </div>

      {!reduceMotion && <motion.span className="lp-track-msg" style={{ x, y, opacity, scale }} />}
    </div>
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
  { icon: 'events', name: 'Workqueue events', body: 'Each message reaches one replica, at least once.', to: '/docs/patterns/events' },
  { icon: 'rpc', name: 'RPC', body: 'Core NATS for latency or JetStream for durability, per module.', to: '/docs/patterns/rpc' },
  { icon: 'broadcast', name: 'Broadcast', body: 'Every service gets every message, late replicas included.', to: '/docs/patterns/broadcast' },
  { icon: 'ordered', name: 'Ordered events', body: 'A strict, replayable sequence for projections and caches.', to: '/docs/patterns/ordered-events' },
  { icon: 'dlq', name: 'Dead-letter queue', body: 'Exhausted messages kept with headers and delivery count.', to: '/docs/guides/dead-letter-queue' },
  { icon: 'schedule', name: 'Cron and delayed jobs', body: 'Fired by NATS itself, with no scheduler process to run.', to: '/docs/guides/scheduling-overview' },
  { icon: 'observe', name: 'Tracing and metrics', body: 'W3C trace context across hops, Prometheus metrics built in.', to: '/docs/observability' },
  { icon: 'health', name: 'Health and shutdown', body: 'Kubernetes probes, and in-flight work drained on SIGTERM.', to: '/docs/guides/health-checks' },
  { icon: 'clusters', name: 'Multiple clusters', body: 'One service talking to several NATS clusters at once.', to: '/docs/guides/multi-connection' },
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

              <ul className="lp-badges" aria-label="Compatibility">
                <li>v{version}</li>
                <li>NestJS 10, 11, 12</li>
                <li>NATS ≥ 2.10</li>
                <li>Node ≥ {NODE_MAJOR}</li>
                <li>MIT</li>
              </ul>
            </div>

            <DeliveryRecord />
          </div>
          <div className="lp-container">
            <MessageTrack />
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
                  <Link to={feature.to} className="lp-feature">
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
                GitHub
              </a>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
