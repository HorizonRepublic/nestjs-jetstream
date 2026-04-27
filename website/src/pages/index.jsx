import React, { useEffect, useRef, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import rootPkg from '../../../package.json';
import './landing.css';

const NPM_PACKAGE = '@horizon-republic/nestjs-jetstream';

const parseNodeMajor = (range) => {
  const m = String(range || '').match(/(\d+)/);

  return m ? m[1] : null;
};

const parsePeerMajors = (range) => {
  const matches = [...String(range || '').matchAll(/\^(\d+)/g)];

  if (!matches.length) return null;

  const majors = matches.map((m) => parseInt(m[1], 10)).sort((a, b) => a - b);

  return `${majors[0]}+`;
};

const NODE_MAJOR = parseNodeMajor(rootPkg.engines?.node);
const NESTJS_MAJORS = parsePeerMajors(rootPkg.peerDependencies?.['@nestjs/common']) ?? '10+';
const FALLBACK_VERSION = rootPkg.version;

const useLiveVersion = (initial) => {
  const [version, setVersion] = useState(initial);

  useEffect(() => {
    let alive = true;
    const url = `https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`;

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data?.version) setVersion(data.version);
      })
      .catch(() => { /* keep fallback */ });

    return () => { alive = false; };
  }, []);

  return version;
};

const SNIPPET_FORROOT = `import { Module } from '@nestjs/common';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    JetstreamModule.forRoot({
      servers: ['nats://localhost:4222'],
    }),
  ],
})
export class AppModule {}`;

const SNIPPET_HANDLER = `import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

@Controller()
export class OrdersController {
  private readonly log = new Logger(OrdersController.name);

  @EventPattern('orders.created')
  async onCreated(@Payload() order: Order) {
    await this.billing.charge(order);
    this.log.log(\`charged \${order.id}\`);
  }

  @MessagePattern('orders.lookup')
  lookup(@Payload() id: string) {
    return this.orders.find(id);
  }
}`;

function BrandMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <path d="M3 7 H10 a4 4 0 0 1 0 8 H3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 7 H16 a4 4 0 0 1 0 8 H9" stroke="oklch(0.86 0.19 145)" strokeWidth="1.5" />
    </svg>
  );
}

function HeroStream() {
  return (
    <svg
      className="lp-hero-stream"
      viewBox="0 0 1440 220"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="lp-lineGrad" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(0.40 0.005 60)" stopOpacity="0" />
          <stop offset="0.5" stopColor="oklch(0.50 0.005 60)" stopOpacity="1" />
          <stop offset="1" stopColor="oklch(0.40 0.005 60)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lp-accentGrad" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(0.86 0.19 145)" stopOpacity="0" />
          <stop offset="0.5" stopColor="oklch(0.86 0.19 145)" stopOpacity="1" />
          <stop offset="1" stopColor="oklch(0.86 0.19 145)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2="1440" y1="40" y2="40" stroke="url(#lp-lineGrad)" strokeWidth="1" />
      <line x1="0" x2="1440" y1="80" y2="80" stroke="url(#lp-lineGrad)" strokeWidth="1" />
      <line x1="0" x2="1440" y1="120" y2="120" stroke="url(#lp-accentGrad)" strokeWidth="1.2" />
      <line x1="0" x2="1440" y1="160" y2="160" stroke="url(#lp-lineGrad)" strokeWidth="1" />
      <line x1="0" x2="1440" y1="200" y2="200" stroke="url(#lp-lineGrad)" strokeWidth="1" />
      <g>
        <circle r="2.2" fill="oklch(0.86 0.19 145)">
          <animate attributeName="cx" from="-10" to="1450" dur="6s" repeatCount="indefinite" />
        </circle>
        <circle r="2.2" cy="120" fill="oklch(0.86 0.19 145)">
          <animate attributeName="cx" from="-200" to="1450" dur="6s" repeatCount="indefinite" />
        </circle>
        <circle r="1.8" cy="80" fill="oklch(0.78 0.005 90)" opacity="0.6">
          <animate attributeName="cx" from="-400" to="1450" dur="8s" repeatCount="indefinite" />
        </circle>
        <circle r="1.8" cy="160" fill="oklch(0.78 0.005 90)" opacity="0.6">
          <animate attributeName="cx" from="-700" to="1450" dur="9s" repeatCount="indefinite" />
        </circle>
        <circle r="2" cy="200" fill="oklch(0.86 0.19 145)" opacity="0.7">
          <animate attributeName="cx" from="-100" to="1450" dur="7s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  );
}

function ArchitectureSvg() {
  return (
    <svg
      viewBox="0 0 1200 400"
      role="img"
      aria-label="Architecture diagram showing publisher application, jetstream-transport library, NATS server with streams, and consumer application"
    >
      <defs>
        <pattern id="lp-dotpat" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="oklch(0.40 0.005 60)" />
        </pattern>
        <linearGradient id="lp-streamGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="oklch(0.86 0.19 145 / 0)" />
          <stop offset="50%" stopColor="oklch(0.86 0.19 145 / 0.9)" />
          <stop offset="100%" stopColor="oklch(0.86 0.19 145 / 0)" />
        </linearGradient>
        <marker id="lp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 Z" fill="oklch(0.50 0.005 60)" />
        </marker>
      </defs>
      <rect width="1200" height="400" fill="url(#lp-dotpat)" opacity="0.4" />

      <g transform="translate(20, 60)">
        <rect width="240" height="260" rx="10" fill="oklch(0.215 0.007 60)" stroke="oklch(0.34 0.006 60)" strokeWidth="1" />
        <text x="20" y="32" fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.60 0.005 90)" letterSpacing="0.06em">PUBLISHER · NESTJS</text>
        <text x="20" y="62" fontFamily="Geist, sans-serif" fontWeight="500" fontSize="15" fill="oklch(0.96 0.005 90)">api-gateway</text>
        <line x1="20" y1="80" x2="220" y2="80" stroke="oklch(0.28 0.006 60)" />
        <g fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.78 0.005 90)">
          <text x="20" y="110">client.emit(</text>
          <text x="20" y="128" fill="oklch(0.86 0.19 145)">  'orders.created',</text>
          <text x="20" y="146" fill="oklch(0.78 0.005 90)">  order</text>
          <text x="20" y="164">);</text>
        </g>
        <rect x="20" y="200" width="200" height="38" rx="6" fill="oklch(0.255 0.007 60)" stroke="oklch(0.34 0.006 60)" />
        <circle cx="36" cy="219" r="3" fill="oklch(0.86 0.19 145)" />
        <text x="48" y="223" fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.78 0.005 90)">ClientProxy + tracing</text>
      </g>

      <g transform="translate(360, 130)">
        <rect width="480" height="120" rx="10" fill="oklch(0.185 0.007 60)" stroke="oklch(0.86 0.19 145 / 0.4)" strokeWidth="1.5" />
        <rect x="0" y="0" width="480" height="120" rx="10" fill="oklch(0.86 0.19 145 / 0.04)" />
        <text x="20" y="28" fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.86 0.19 145)" letterSpacing="0.06em">LIBRARY · @horizon-republic/nestjs-jetstream</text>
        <g fontFamily="Geist Mono, monospace" fontSize="11">
          <rect x="20" y="48" width="100" height="26" rx="4" fill="oklch(0.215 0.007 60)" stroke="oklch(0.34 0.006 60)" />
          <text x="70" y="65" textAnchor="middle" fill="oklch(0.96 0.005 90)">forRoot()</text>
          <rect x="130" y="48" width="110" height="26" rx="4" fill="oklch(0.215 0.007 60)" stroke="oklch(0.34 0.006 60)" />
          <text x="185" y="65" textAnchor="middle" fill="oklch(0.96 0.005 90)">forFeature()</text>
          <rect x="250" y="48" width="100" height="26" rx="4" fill="oklch(0.215 0.007 60)" stroke="oklch(0.34 0.006 60)" />
          <text x="300" y="65" textAnchor="middle" fill="oklch(0.96 0.005 90)">Strategy</text>
          <rect x="360" y="48" width="100" height="26" rx="4" fill="oklch(0.215 0.007 60)" stroke="oklch(0.34 0.006 60)" />
          <text x="410" y="65" textAnchor="middle" fill="oklch(0.96 0.005 90)">Codec</text>
          <text x="20" y="100" fill="oklch(0.60 0.005 90)">Ack · retry · DLQ · ordered · broadcast · RPC · trace context</text>
        </g>
      </g>

      <g transform="translate(940, 60)">
        <rect width="240" height="260" rx="10" fill="oklch(0.215 0.007 60)" stroke="oklch(0.34 0.006 60)" strokeWidth="1" />
        <text x="20" y="32" fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.60 0.005 90)" letterSpacing="0.06em">CONSUMER · NESTJS</text>
        <text x="20" y="62" fontFamily="Geist, sans-serif" fontWeight="500" fontSize="15" fill="oklch(0.96 0.005 90)">orders-svc</text>
        <line x1="20" y1="80" x2="220" y2="80" stroke="oklch(0.28 0.006 60)" />
        <g fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.78 0.005 90)">
          <text x="20" y="110" fill="oklch(0.84 0.12 30)">@EventPattern(</text>
          <text x="20" y="128" fill="oklch(0.86 0.19 145)">  'orders.created'</text>
          <text x="20" y="146" fill="oklch(0.78 0.005 90)">)</text>
          <text x="20" y="164">{'onCreated(o) { … }'}</text>
        </g>
        <rect x="20" y="200" width="200" height="38" rx="6" fill="oklch(0.255 0.007 60)" stroke="oklch(0.34 0.006 60)" />
        <circle cx="36" cy="219" r="3" fill="oklch(0.86 0.19 145)" />
        <text x="48" y="223" fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.78 0.005 90)">ack · retry · DLQ</text>
      </g>

      <g transform="translate(300, 310)">
        <rect width="600" height="60" rx="8" fill="oklch(0.215 0.007 60)" stroke="oklch(0.34 0.006 60)" />
        <text x="20" y="26" fontFamily="Geist Mono, monospace" fontSize="11" fill="oklch(0.60 0.005 90)" letterSpacing="0.06em">NATS SERVER · JETSTREAM</text>
        <text x="20" y="46" fontFamily="Geist Mono, monospace" fontSize="12" fill="oklch(0.78 0.005 90)">stream: orders · subjects: orders.&gt; · replicas: 3 · workqueue</text>
        <g transform="translate(400, 18)">
          <line x1="0" x2="170" y1="14" y2="14" stroke="url(#lp-streamGrad)" strokeWidth="1.5" />
          <circle cx="20" cy="14" r="2" fill="oklch(0.86 0.19 145)" />
          <circle cx="60" cy="14" r="2" fill="oklch(0.86 0.19 145)" />
          <circle cx="100" cy="14" r="2" fill="oklch(0.86 0.19 145)" />
          <circle cx="140" cy="14" r="2" fill="oklch(0.86 0.19 145)" />
        </g>
      </g>

      <g fill="none" stroke="oklch(0.50 0.005 60)" strokeWidth="1.2" markerEnd="url(#lp-arrow)">
        <path d="M260 190 H360" />
        <path d="M840 190 H940" />
        <path d="M600 250 V310" />
      </g>
      <g fontFamily="Geist Mono, monospace" fontSize="10" fill="oklch(0.60 0.005 90)" textAnchor="middle">
        <text x="310" y="182">emit</text>
        <text x="890" y="182">deliver</text>
      </g>
    </svg>
  );
}

const FILE_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M3 2h6l4 4v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
    <path d="M9 2v4h4" />
  </svg>
);

function CopyButton({ snippet }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(snippet); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button className={`lp-codeblock-copy ${copied ? 'copied' : ''}`} onClick={onCopy}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" />
      </svg>
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function Reveal({ children, className = '', as: Tag = 'div', ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { node.classList.add('in'); io.unobserve(node); }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref} className={`lp-reveal ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

function FeatureCard({ to, icon, name, desc }) {
  return (
    <Link className="lp-feature" to={to}>
      <div className="lp-feature-head">
        <svg className="lp-feature-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          {icon}
        </svg>
        <h3 className="lp-feature-name">{name}</h3>
      </div>
      <p className="lp-feature-desc">{desc}</p>
      <span className="lp-feature-arrow">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </span>
    </Link>
  );
}

const HIGHLIGHTED_FORROOT = `<span class="tok-kw">import</span> <span class="tok-pun">{</span> <span class="tok-prop">Module</span> <span class="tok-pun">}</span> <span class="tok-kw">from</span> <span class="tok-str">'@nestjs/common'</span><span class="tok-pun">;</span>
<span class="tok-kw">import</span> <span class="tok-pun">{</span> <span class="tok-prop">JetstreamModule</span> <span class="tok-pun">}</span> <span class="tok-kw">from</span> <span class="tok-str">'@horizon-republic/nestjs-jetstream'</span><span class="tok-pun">;</span>

<span class="tok-dec">@Module</span><span class="tok-pun">({</span>
  <span class="tok-prop">imports</span><span class="tok-pun">: [</span>
    <span class="tok-prop">JetstreamModule</span><span class="tok-pun">.</span><span class="tok-fn">forRoot</span><span class="tok-pun">({</span>
      <span class="tok-prop">servers</span><span class="tok-pun">:</span> <span class="tok-pun">[</span><span class="tok-str">'nats://localhost:4222'</span><span class="tok-pun">],</span>
    <span class="tok-pun">}),</span>
  <span class="tok-pun">],</span>
<span class="tok-pun">})</span>
<span class="tok-kw">export class</span> <span class="tok-ty">AppModule</span> <span class="tok-pun">{}</span>`;

const HIGHLIGHTED_HANDLER = `<span class="tok-kw">import</span> <span class="tok-pun">{</span> <span class="tok-prop">Controller</span><span class="tok-pun">,</span> <span class="tok-prop">Logger</span> <span class="tok-pun">}</span> <span class="tok-kw">from</span> <span class="tok-str">'@nestjs/common'</span><span class="tok-pun">;</span>
<span class="tok-kw">import</span> <span class="tok-pun">{</span> <span class="tok-prop">EventPattern</span><span class="tok-pun">,</span> <span class="tok-prop">Payload</span> <span class="tok-pun">}</span> <span class="tok-kw">from</span> <span class="tok-str">'@nestjs/microservices'</span><span class="tok-pun">;</span>

<span class="tok-com">// At-least-once. Retries on throw. Traced end-to-end.</span>
<span class="tok-dec">@Controller</span><span class="tok-pun">()</span>
<span class="tok-kw">export class</span> <span class="tok-ty">OrdersController</span> <span class="tok-pun">{</span>
  <span class="tok-kw">private readonly</span> <span class="tok-prop">log</span> <span class="tok-pun">=</span> <span class="tok-kw">new</span> <span class="tok-ty">Logger</span><span class="tok-pun">(</span><span class="tok-ty">OrdersController</span><span class="tok-pun">.</span><span class="tok-prop">name</span><span class="tok-pun">);</span>

  <span class="tok-dec">@EventPattern</span><span class="tok-pun">(</span><span class="tok-str">'orders.created'</span><span class="tok-pun">)</span>
  <span class="tok-kw">async</span> <span class="tok-fn">onCreated</span><span class="tok-pun">(</span><span class="tok-dec">@Payload</span><span class="tok-pun">()</span> <span class="tok-prop">order</span><span class="tok-pun">:</span> <span class="tok-ty">Order</span><span class="tok-pun">) {</span>
    <span class="tok-kw">await this</span><span class="tok-pun">.</span><span class="tok-prop">billing</span><span class="tok-pun">.</span><span class="tok-fn">charge</span><span class="tok-pun">(</span><span class="tok-prop">order</span><span class="tok-pun">);</span>
    <span class="tok-kw">this</span><span class="tok-pun">.</span><span class="tok-prop">log</span><span class="tok-pun">.</span><span class="tok-fn">log</span><span class="tok-pun">(</span><span class="tok-str">\`charged \${order.id}\`</span><span class="tok-pun">);</span>
  <span class="tok-pun">}</span>

  <span class="tok-dec">@MessagePattern</span><span class="tok-pun">(</span><span class="tok-str">'orders.lookup'</span><span class="tok-pun">)</span>
  <span class="tok-fn">lookup</span><span class="tok-pun">(</span><span class="tok-dec">@Payload</span><span class="tok-pun">()</span> <span class="tok-prop">id</span><span class="tok-pun">:</span> <span class="tok-ty">string</span><span class="tok-pun">) {</span>
    <span class="tok-kw">return this</span><span class="tok-pun">.</span><span class="tok-prop">orders</span><span class="tok-pun">.</span><span class="tok-fn">find</span><span class="tok-pun">(</span><span class="tok-prop">id</span><span class="tok-pun">);</span>
  <span class="tok-pun">}</span>
<span class="tok-pun">}</span>`;

export default function Home() {
  const version = useLiveVersion(FALLBACK_VERSION);
  const versionLabel = `v${version}`;
  const githubHref = 'https://github.com/HorizonRepublic/nestjs-jetstream';
  const npmHref = 'https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream';

  useEffect(() => {
    document.body.dataset.page = 'landing';
    return () => { delete document.body.dataset.page; };
  }, []);

  return (
    <Layout
      title="nestjs-jetstream — Production NATS JetStream transport for NestJS"
      description="Production NATS JetStream transport for NestJS. Durable events, broadcast fan-out, ordered delivery, RPC, dead-letter queues, and distributed tracing — under the same @EventPattern decorators you already use."
      noFooter
    >
      <div className="landingRoot">

        <section className="lp-hero">
          <div className="lp-hero-bg" aria-hidden="true">
            <div className="lp-hero-grid" />
            <div className="lp-hero-glow" />
            <HeroStream />
          </div>
          <div className="lp-container lp-hero-inner">
            <div className="lp-eyebrow lp-fade-up">
              <span className="lp-eyebrow-dot" />
              <strong>{versionLabel}</strong>
              <span className="lp-eyebrow-sep">·</span>
              <span>MIT</span>
            </div>
            <h1 className="lp-hero-title lp-fade-up lp-delay-1">
              nestjs-<span className="lp-accent-mark">jetstream</span>
            </h1>
            <p className="lp-hero-sub lp-fade-up lp-delay-2">
              The NATS JetStream transport NestJS microservices need — durable, retried, traced —
              under the same <code>@EventPattern</code> decorators you already use.
            </p>
            <div className="lp-hero-ctas lp-fade-up lp-delay-3">
              <Link className="lp-btn lp-btn-primary" to="/docs/getting-started/quick-start">
                Get started
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M3 8h10M9 4l4 4-4 4" />
                </svg>
              </Link>
              <a className="lp-btn lp-btn-secondary" href={githubHref} target="_blank" rel="noopener noreferrer">
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.37-.93-.9-1.18-.9-1.18-.73-.5.06-.49.06-.49.81.06 1.24.83 1.24.83.72 1.23 1.88.88 2.34.67.07-.52.28-.88.5-1.08-1.78-.2-3.65-.89-3.65-3.96 0-.88.31-1.6.83-2.16-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.83a7.7 7.7 0 0 1 4 0c1.53-1.04 2.2-.83 2.2-.83.44 1.11.16 1.93.08 2.13.52.56.83 1.28.83 2.16 0 3.08-1.88 3.76-3.66 3.96.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z" />
                </svg>
                View on GitHub
              </a>
              <a className="lp-btn lp-btn-secondary" href={npmHref} target="_blank" rel="noopener noreferrer">
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M0 0v16h16V0H0zm13 13h-2V5H8v8H3V3h10v10z" />
                </svg>
                View on npm
              </a>
            </div>
            <div className="lp-hero-meta lp-fade-up lp-delay-4">
              <span className="lp-hero-meta-item"><strong>npm i</strong> @horizon-republic/nestjs-jetstream</span>
              <span className="lp-hero-meta-dot" />
              <span className="lp-hero-meta-item">MIT</span>
              <span className="lp-hero-meta-dot" />
              {NODE_MAJOR && (
                <>
                  <span className="lp-hero-meta-item">Node <strong>≥ {NODE_MAJOR}</strong></span>
                  <span className="lp-hero-meta-dot" />
                </>
              )}
              {NESTJS_MAJORS && (
                <span className="lp-hero-meta-item">NestJS <strong>{NESTJS_MAJORS}</strong></span>
              )}
            </div>
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-container">
            <Reveal>
              <span className="lp-eyelet">Why this library</span>
              <h2 className="lp-section-title">Five primitives, one transport.</h2>
              <p className="lp-section-sub">Each one drops in behind the decorators you already use. Same behavior in dev, staging, and prod.</p>
            </Reveal>
            <Reveal className="lp-pillars">
              <article className="lp-pillar span-3">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 8h2l1.5-4 3 8 2-6 1.5 2H14" />
                  </svg>
                </div>
                <h3 className="lp-pillar-title">At-least-once delivery, bounded retries</h3>
                <p className="lp-pillar-text">Every event is acknowledged after the handler returns. Failures retry with exponential backoff and land in a typed dead-letter queue if the budget is exhausted.</p>
                <div className="lp-pillar-visual">
                  <div className="lp-viz-delivery" aria-hidden="true">
                    {Array.from({ length: 14 }).map((_, i) => <span key={i} />)}
                  </div>
                </div>
              </article>

              <article className="lp-pillar span-3">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="3" cy="8" r="1.5" />
                    <circle cx="13" cy="3" r="1.5" />
                    <circle cx="13" cy="8" r="1.5" />
                    <circle cx="13" cy="13" r="1.5" />
                    <path d="M4.5 8h7M4.5 8L13 3M4.5 8L13 13" />
                  </svg>
                </div>
                <h3 className="lp-pillar-title">Broadcast fan-out across replicas</h3>
                <p className="lp-pillar-text">One <code>@Broadcast()</code> event reaches every running pod — with no double-processing on the workqueue side.</p>
                <div className="lp-pillar-visual">
                  <div className="lp-viz-broadcast" aria-hidden="true">
                    <span className="lp-viz-broadcast-src" />
                    <span className="lp-viz-broadcast-targets">
                      <span className="lp-viz-broadcast-row"><span className="lp-viz-broadcast-line" /><span className="lp-viz-broadcast-pill">api-gateway-7f2</span></span>
                      <span className="lp-viz-broadcast-row"><span className="lp-viz-broadcast-line" /><span className="lp-viz-broadcast-pill">api-gateway-9c4</span></span>
                      <span className="lp-viz-broadcast-row"><span className="lp-viz-broadcast-line" /><span className="lp-viz-broadcast-pill">api-gateway-1ab</span></span>
                    </span>
                  </div>
                </div>
              </article>

              <article className="lp-pillar span-2">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 5h8M10 5l-2-2M10 5l-2 2" />
                    <path d="M14 11H6M6 11l2-2M6 11l2 2" />
                  </svg>
                </div>
                <h3 className="lp-pillar-title">RPC over Core &amp; JetStream</h3>
                <p className="lp-pillar-text">Request/reply with timeouts, typed responses, and the <code>RecordBuilder</code> for headers.</p>
                <div className="lp-pillar-visual">
                  <div className="lp-viz-rpc" aria-hidden="true">
                    <span className="lp-viz-rpc-pill">client.send</span>
                    <span className="lp-viz-rpc-arrow" />
                    <span className="lp-viz-rpc-pill">@MessagePattern</span>
                  </div>
                </div>
              </article>

              <article className="lp-pillar span-2">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 8h12" />
                    <circle cx="5" cy="8" r="1.5" />
                    <circle cx="11" cy="8" r="1.5" />
                    <path d="M5 8v3M11 8v-3" />
                  </svg>
                </div>
                <h3 className="lp-pillar-title">Distributed tracing, on by default</h3>
                <p className="lp-pillar-text">W3C <code>traceparent</code> propagated through every hop. Wire to OpenTelemetry in three lines.</p>
                <div className="lp-pillar-visual">
                  <div className="lp-viz-trace" aria-hidden="true">
                    <div className="lp-trace-row"><span className="lp-trace-label">api-gateway</span><span className="lp-trace-bar" style={{ width: '60%' }} /></div>
                    <div className="lp-trace-row"><span className="lp-trace-label">orders.svc</span><span className="lp-trace-bar" style={{ width: '40%', marginLeft: '12%' }} /></div>
                    <div className="lp-trace-row"><span className="lp-trace-label">billing.svc</span><span className="lp-trace-bar dim" style={{ width: '28%', marginLeft: '18%' }} /></div>
                  </div>
                </div>
              </article>

              <article className="lp-pillar span-2">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <path d="M2 6h12M5 9h6" />
                  </svg>
                </div>
                <h3 className="lp-pillar-title">Ordered delivery per partition</h3>
                <p className="lp-pillar-text">Stable subject keys give you single-consumer ordering without giving up horizontal scale on the rest of the workload.</p>
                <div className="lp-pillar-visual">
                  <div className="lp-viz-ordered">
                    <span>orders.42</span>
                    <span className="active">orders.42 →</span>
                    <span>orders.42</span>
                  </div>
                </div>
              </article>
            </Reveal>
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-container">
            <Reveal>
              <span className="lp-eyelet">Live code</span>
              <h2 className="lp-section-title">Configure once. Decorate handlers. Ship.</h2>
              <p className="lp-section-sub">Same NestJS surface area you use today. The library does the JetStream work underneath.</p>
            </Reveal>

            <Reveal className="lp-demo-grid">
              <div className="lp-codeblock">
                <div className="lp-codeblock-head">
                  <span className="lp-codeblock-file">{FILE_ICON}app.module.ts</span>
                  <span className="lp-codeblock-lang">TypeScript</span>
                  <CopyButton snippet={SNIPPET_FORROOT} />
                </div>
                <div className="lp-codeblock-body">
                  <pre><code dangerouslySetInnerHTML={{ __html: HIGHLIGHTED_FORROOT }} /></pre>
                </div>
              </div>
              <div className="lp-codeblock">
                <div className="lp-codeblock-head">
                  <span className="lp-codeblock-file">{FILE_ICON}orders.controller.ts</span>
                  <span className="lp-codeblock-lang">TypeScript</span>
                  <CopyButton snippet={SNIPPET_HANDLER} />
                </div>
                <div className="lp-codeblock-body">
                  <pre><code dangerouslySetInnerHTML={{ __html: HIGHLIGHTED_HANDLER }} /></pre>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-container">
            <Reveal style={{ textAlign: 'center', maxWidth: 680, margin: '0 auto 56px' }}>
              <span className="lp-eyelet" style={{ marginLeft: 'auto', marginRight: 'auto' }}>Architecture</span>
              <h2 className="lp-section-title" style={{ marginLeft: 'auto', marginRight: 'auto' }}>Sits between your application and the stream.</h2>
              <p className="lp-section-sub" style={{ marginLeft: 'auto', marginRight: 'auto' }}>Provisions streams &amp; consumers on boot, routes messages to decorated handlers, drains cleanly on shutdown.</p>
            </Reveal>
            <Reveal className="lp-arch">
              <ArchitectureSvg />
              <div className="lp-arch-caption">Publish → stream → consumer. The library owns provisioning, routing, retries, and tracing on both sides.</div>
            </Reveal>
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-container">
            <Reveal>
              <span className="lp-eyelet">All capabilities</span>
              <h2 className="lp-section-title">Everything a professional team expects from production messaging.</h2>
              <p className="lp-section-sub">Twelve features in one transport. No surprises across environments.</p>
            </Reveal>
            <Reveal className="lp-features">
              <div className="lp-feature-group">Delivery</div>
              <FeatureCard to="/docs/patterns/events" icon={<path d="M3 8l3 3 7-7" />} name="At-least-once events" desc="Workqueue retention with explicit ack after handler resolves." />
              <FeatureCard to="/docs/patterns/ordered-events" icon={<><circle cx="8" cy="8" r="5.5" /><path d="M8 4v4l3 2" /></>} name="Ordered events" desc="Per-key ordering on the same partition with stable subjects." />
              <FeatureCard to="/docs/patterns/broadcast" icon={<><circle cx="3" cy="8" r="1.5" /><circle cx="13" cy="3" r="1.5" /><circle cx="13" cy="13" r="1.5" /><path d="M4.5 7L12 4M4.5 9L12 12" /></>} name="Broadcast fan-out" desc="One emit reaches every replica; nothing is shared by accident." />

              <div className="lp-feature-group">Reliability</div>
              <FeatureCard to="/docs/guides/dead-letter-queue" icon={<><rect x="3" y="3" width="10" height="10" rx="1.5" /><path d="M6 8h4" /></>} name="Dead-letter queue" desc="Bounded retries, then a typed sink with original headers preserved." />
              <FeatureCard to="/docs/guides/graceful-shutdown" icon={<><path d="M2 12L8 4l6 8" /><path d="M5 12h6" /></>} name="Graceful shutdown" desc="Drains in-flight handlers, flushes acks, closes the connection." />
              <FeatureCard to="/docs/guides/health-checks" icon={<><circle cx="8" cy="8" r="5.5" /><path d="M5 8l2 2 4-4" /></>} name="Health checks" desc={<>Drop-in <code>isHealthy()</code> indicator for k8s probes.</>} />

              <div className="lp-feature-group">Patterns</div>
              <FeatureCard to="/docs/patterns/rpc" icon={<><path d="M2 5h8M10 5l-2-2M10 5l-2 2" /><path d="M14 11H6M6 11l2-2M6 11l2 2" /></>} name="RPC (Core & JetStream)" desc="Request/reply with deadlines, headers, and typed responses." />
              <FeatureCard to="/docs/guides/scheduling" icon={<><circle cx="8" cy="8" r="5.5" /><path d="M8 4v4l3 1" /></>} name="Scheduled messages" desc="Per-message delay or absolute deliver-at, native to the stream." />
              <FeatureCard to="/docs/guides/per-message-ttl" icon={<><path d="M3 13L13 3" /><circle cx="4" cy="12" r="1" /><circle cx="12" cy="4" r="1" /></>} name="Per-message TTL" desc="Expire stale messages before they reach a consumer." />

              <div className="lp-feature-group">Observability</div>
              <FeatureCard to="/docs/guides/distributed-tracing" icon={<><path d="M2 8h12" /><circle cx="5" cy="8" r="1.5" /><circle cx="11" cy="8" r="1.5" /></>} name="Distributed tracing" desc="W3C trace context on every hop. OpenTelemetry-compatible." />
              <FeatureCard to="/docs/reference/header-contract" icon={<path d="M3 12V4M3 4h6l4 4-4 4H3" />} name="Header contract" desc="Stable, documented header schema for tracing & correlation." />
              <FeatureCard to="/docs/guides/lifecycle-hooks" icon={<><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12M5 9h6" /></>} name="Lifecycle hooks" desc={<>Subscribe to <code>TransportEvent</code> for ack, nak, redelivery.</>} />
            </Reveal>
          </div>
        </section>

        <section className="lp-section" style={{ padding: '80px 0' }}>
          <div className="lp-container" style={{ textAlign: 'center' }}>
            <Reveal>
              <h2 className="lp-section-title" style={{ margin: '0 auto 16px' }}>Read the docs. Ship the code.</h2>
              <p className="lp-section-sub" style={{ margin: '0 auto 32px' }}>Five-minute quick start. Then drop into your existing NestJS module graph.</p>
              <div className="lp-hero-ctas" style={{ justifyContent: 'center' }}>
                <Link className="lp-btn lp-btn-primary" to="/docs/getting-started/quick-start">
                  Quick start
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
                </Link>
                <Link className="lp-btn lp-btn-secondary" to="/docs/">Read intro →</Link>
              </div>
            </Reveal>
          </div>
        </section>

        <footer className="lp-footer">
          <div className="lp-container">
            <div className="lp-footer-grid">
              <div className="lp-footer-brand">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--lp-fg-0)' }}>
                  <BrandMark />
                  <span>nestjs-jetstream</span>
                </div>
                <p>A production NATS JetStream transport for NestJS — by Horizon Republic.</p>
              </div>
              <div className="lp-footer-col">
                <h4>Docs</h4>
                <Link to="/docs/">Introduction</Link>
                <Link to="/docs/getting-started/quick-start">Quick start</Link>
                <Link to="/docs/getting-started/why-jetstream">Why JetStream?</Link>
                <Link to="/docs/reference/api">API reference</Link>
              </div>
              <div className="lp-footer-col">
                <h4>Patterns</h4>
                <Link to="/docs/patterns/events">Events</Link>
                <Link to="/docs/patterns/broadcast">Broadcast</Link>
                <Link to="/docs/patterns/rpc">RPC</Link>
                <Link to="/docs/patterns/ordered-events">Ordered delivery</Link>
              </div>
              <div className="lp-footer-col">
                <h4>Community</h4>
                <a href={githubHref} target="_blank" rel="noopener noreferrer">GitHub</a>
                <a href={npmHref} target="_blank" rel="noopener noreferrer">npm</a>
                <a href="https://github.com/HorizonRepublic/nestjs-jetstream/issues" target="_blank" rel="noopener noreferrer">Issues</a>
                <a href="https://github.com/HorizonRepublic/nestjs-jetstream/releases" target="_blank" rel="noopener noreferrer">Changelog</a>
              </div>
            </div>
            <div className="lp-footer-bar">
              <span>MIT · © {new Date().getFullYear()} Horizon Republic</span>
              <span className="lp-footer-meta">
                <span className="lp-footer-status"><span className="lp-footer-status-dot" /> All systems operational</span>
                <span><strong>{versionLabel}</strong></span>
              </span>
            </div>
          </div>
        </footer>
      </div>
    </Layout>
  );
}
