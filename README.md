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
  <a href="https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream"><img src="https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream?style=flat&label=npm&labelColor=3d4450&color=2c5fb3" alt="npm version"/></a>
  <a href="https://github.com/HorizonRepublic/nestjs-jetstream/actions/workflows/coverage.yml"><img src="https://img.shields.io/github/actions/workflow/status/HorizonRepublic/nestjs-jetstream/coverage.yml?branch=main&style=flat&label=ci&labelColor=3d4450&color=2c5fb3" alt="CI status"/></a>
  <a href="https://codecov.io/github/HorizonRepublic/nestjs-jetstream"><img src="https://img.shields.io/codecov/c/github/HorizonRepublic/nestjs-jetstream?style=flat&label=coverage&labelColor=3d4450&color=2c5fb3&token=40IPSWFMT4" alt="test coverage"/></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-2c5fb3?style=flat&labelColor=3d4450" alt="MIT license"/></a>
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

NestJS ships a built-in NATS transport that is fire-and-forget. A message in
flight when a pod restarts is gone, a handler that throws is never retried, and
when something goes wrong in production there is nothing to look at.

## The swap

Same decorators, same `client.emit()`. One module import changes underneath.

```ts
// app.module.ts
@Module({
  imports: [JetstreamModule.forRoot({ servers: ['nats://localhost:4222'] })],
})
export class AppModule {}
```

```ts
// orders.controller.ts
@Controller()
export class OrdersController {
  @EventPattern('orders.created')
  async onCreated(@Payload() order: Order) {
    await this.billing.charge(order); // throws → nak → redelivered with backoff
  }
}
```

Every event is acknowledged only after the handler resolves. A throw is a `nak`
with exponential backoff. Exhausted retries are routed to a typed dead-letter
queue with the original headers intact. A `traceparent` header rides through every hop.

## What you get

| Capability             | How                                                                     |
| ---------------------- | ----------------------------------------------------------------------- |
| At-least-once delivery | Ack after the handler resolves, with bounded retries and backoff        |
| Broadcast              | One message to every running pod via per-service durable consumers      |
| Ordered delivery       | Sequential per partition key, without giving up horizontal scale        |
| RPC                    | Core NATS for speed or JetStream for durability, same `@MessagePattern` |
| Dead-letter queue      | Typed sink, original headers preserved, `onDeadLetter` callback         |
| Tracing                | W3C `traceparent` propagated end to end, OpenTelemetry spans built in   |
| Operations             | Health checks, graceful shutdown, scheduled messages, per-message TTL   |

## Install

```bash
npm i @horizon-republic/nestjs-jetstream
```

Requires Node >= 20, NestJS 10 to 12, and NATS Server >= 2.10 with JetStream
enabled.

## Where to go next

- **Evaluating?** [Why JetStream?](https://nestjs-jetstream.horizon-republic.dev/docs/getting-started/why-jetstream) states the trade-offs, including where the built-in transport is enough.
- **Integrating?** The [reference](https://nestjs-jetstream.horizon-republic.dev/docs/reference/module-configuration) has every config key, default value and header name.
- **Debugging?** [Troubleshooting](https://nestjs-jetstream.horizon-republic.dev/docs/guides/troubleshooting) documents the failure paths, from consumer lag to redelivery loops to DLQ traffic.

One runnable example per pattern, ten in all, lives under [`examples/`](./examples).

Versioning follows semver: breaking changes land on majors, and the
[header contract](https://nestjs-jetstream.horizon-republic.dev/docs/reference/header-contract)
holds across minors.

---

MIT · © 2026 Horizon Republic · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
