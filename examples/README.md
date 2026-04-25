# Examples

Runnable examples demonstrating key features. Each is self-contained — pick the one closest to your use case and copy-paste.

## Prerequisites

```bash
# Start NATS (requires Docker)
docker compose up -d
```

## Running

```bash
# Default example (basic)
pnpm start:example

# Any specific example
npx tsx --tsconfig examples/tsconfig.json examples/03-ordered-events/main.ts
```

## Examples

| # | Example | Port | Features | Endpoints |
|---|---------|------|----------|-----------|
| 01 | [basic](./01-basic) | 3000 | Workqueue events, broadcast, core RPC | `GET /emit`, `/broadcast`, `/rpc` |
| 02 | [rpc-jetstream](./02-rpc-jetstream) | 3001 | JetStream RPC, RecordBuilder, custom headers | `GET /pay` |
| 03 | [ordered-events](./03-ordered-events) | 3002 | Strict sequential delivery, projections | `GET /sequence` |
| 04 | [dead-letter](./04-dead-letter) | 3003 | DLQ, onDeadLetter callback, retry exhaustion | `GET /fail` |
| 05 | [health-checks](./05-health-checks) | 3004 | Health indicator, Terminus-compatible | `GET /health`, `/health/terminus` |
| 06 | [scheduling](./06-scheduling) | 3005 | Delayed delivery via scheduleAt() (NATS >= 2.12) | `GET /schedule` |
| 07 | [publisher-only](./07-publisher-only) | 3006 | consumer: false, API gateway pattern | `GET /place-order` |
| 08 | [per-message-ttl](./08-per-message-ttl) | 3007 | Individual message expiration (NATS >= 2.11) | `GET /token` |
| 09 | [handler-metadata](./09-handler-metadata) | 3008 | KV metadata registry, service discovery | — |
| 10 | [distributed-tracing](./10-distributed-tracing) | 3009 | Built-in OpenTelemetry spans, ConsoleSpanExporter, full trace through publish + RPC + event flow | `GET /` |
