<p align="center">
  <img src="website/static/img/logo.svg" width="56" alt="nestjs-jetstream mark: three stream lines committing to a record"/>
</p>

<h1 align="center">nestjs-jetstream</h1>

<p align="center">
  A NATS JetStream transport for NestJS microservices.<br/>
  Same <code>@EventPattern</code> and <code>@MessagePattern</code> decorators, with durability,<br/>
  bounded retries, dead-letter queues and OpenTelemetry tracing underneath.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream"><img src="https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream" alt="npm version"/></a>
  <a href="https://github.com/HorizonRepublic/nestjs-jetstream/actions/workflows/coverage.yml"><img src="https://github.com/HorizonRepublic/nestjs-jetstream/actions/workflows/coverage.yml/badge.svg?branch=main" alt="CI status"/></a>
  <a href="https://codecov.io/gh/HorizonRepublic/nestjs-jetstream"><img src="https://codecov.io/gh/HorizonRepublic/nestjs-jetstream/graph/badge.svg?token=40IPSWFMT4" alt="test coverage"/></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/github/license/HorizonRepublic/nestjs-jetstream" alt="MIT license"/></a>
</p>

<p align="center">
  <a href="https://nestjs-jetstream.horizon-republic.dev/"><b>Documentation</b></a>
  ·
  <a href="https://nestjs-jetstream.horizon-republic.dev/docs/getting-started/quick-start">Quick start</a>
  ·
  <a href="https://nestjs-jetstream.horizon-republic.dev/docs/reference/header-contract">Header contract</a>
  ·
  <a href="./examples">Examples</a>
</p>

---

## The problem

NestJS includes a built-in NATS transport that is fire-and-forget. A pod restart
loses whatever was in flight, a handler that throws is never retried, and when
something goes wrong in production there is nothing to look at.

## The swap

Same decorators, same `client.emit()`. The module and the strategy change
underneath.

```ts
// app.module.ts
@Module({
  imports: [
    JetstreamModule.forRoot({ name: 'orders', servers: ['nats://localhost:4222'] }),
    JetstreamModule.forFeature({ name: 'orders' }), // client for emit() and send()
  ],
  controllers: [OrdersController],
})
export class AppModule {}

// main.ts
app.connectMicroservice({ strategy: app.get(JetstreamStrategy) });
```

```ts
// orders.controller.ts
@Controller()
export class OrdersController {
  @EventPattern('orders.created')
  async onCreated(@Payload() order: Order) {
    await this.billing.charge(order); // throws: nak, redelivered after a delay
  }
}
```

The transport acknowledges an event only after its handler resolves. A throw is
a `nak` with a delay, 2 s and then 10 s by default. A message that runs out of
attempts, or whose handler never settles it, goes to a dead-letter stream with
its original headers. A `traceparent` header rides through every hop.

## What you get

| Capability             | How                                                                          |
| ---------------------- | ---------------------------------------------------------------------------- |
| At-least-once delivery | Ack after the handler resolves, with paced, bounded retries                  |
| Broadcast              | One copy to every service, through a durable consumer per service            |
| Ordered delivery       | Strict sequence, with every instance reading the whole stream                |
| RPC                    | Core NATS for speed or JetStream for durability, same `@MessagePattern`      |
| Dead-letter queue      | DLQ stream on by default, original headers kept, `onDeadLetter` callback     |
| Scheduling             | Delayed messages, per-message TTL, cron and interval jobs run by NATS itself |
| Multiple clusters      | One service talks to several NATS clusters through named connections         |
| Tracing and metrics    | W3C `traceparent` end to end, OpenTelemetry spans, Prometheus metrics        |
| Operations             | Health checks, graceful shutdown, bring-your-own streams and consumers       |

## Install

```bash
npm i @horizon-republic/nestjs-jetstream
```

Requires Node >= 22, NestJS 10 to 12, and NATS Server >= 2.10 with JetStream
enabled. Scheduling features need a newer server; see
[NATS server versions](https://nestjs-jetstream.horizon-republic.dev/docs/getting-started/installation#nats-server-versions).
Upgrading from 2.x? Read
[Upgrading](https://nestjs-jetstream.horizon-republic.dev/docs/reference/upgrading).

## Where to go next

- **Evaluating?**
  [Why JetStream?](https://nestjs-jetstream.horizon-republic.dev/docs/getting-started/why-jetstream)
  states the trade-offs, including where the built-in transport is enough.
- **Integrating?** The
  [reference](https://nestjs-jetstream.horizon-republic.dev/docs/reference/module-configuration)
  has every config key, default value and header name.
- **Debugging?**
  [Troubleshooting](https://nestjs-jetstream.horizon-republic.dev/docs/guides/troubleshooting)
  documents the failure paths, from consumer lag to redelivery loops to DLQ
  traffic.

Twelve runnable examples, one per pattern, live under [`examples/`](./examples).

Versioning follows semver: breaking changes come only in majors, and the
[header contract](https://nestjs-jetstream.horizon-republic.dev/docs/reference/header-contract)
does not change across minors.

---

MIT · © 2026 Horizon Republic · [Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
