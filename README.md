<p align="center">
  <img src="website/static/img/logo.svg" width="80" alt="nestjs-jetstream"/>
</p>

<h1 align="center">nestjs-jetstream</h1>

<p align="center">
  The NATS JetStream transport NestJS microservices need —
  durable, retried, traced — under the same <code>@EventPattern</code>
  and <code>@MessagePattern</code> decorators you already use.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream"><img src="https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream?style=flat&color=f5f5f5&labelColor=CB3837&logo=npm&logoColor=white" alt="npm"/></a>&nbsp;
  <a href="https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream"><img src="https://img.shields.io/npm/dm/@horizon-republic/nestjs-jetstream?style=flat&color=f5f5f5&labelColor=CB3837&logo=npm&logoColor=white" alt="npm downloads"/></a>&nbsp;
  <a href="https://github.com/HorizonRepublic/nestjs-jetstream/actions/workflows/coverage.yml"><img src="https://img.shields.io/github/actions/workflow/status/HorizonRepublic/nestjs-jetstream/coverage.yml?branch=main&style=flat&color=f5f5f5&labelColor=181717&logo=githubactions&logoColor=white&label=ci" alt="CI"/></a>&nbsp;
  <a href="https://codecov.io/github/HorizonRepublic/nestjs-jetstream"><img src="https://img.shields.io/codecov/c/github/HorizonRepublic/nestjs-jetstream?style=flat&color=f5f5f5&labelColor=F01F7A&token=40IPSWFMT4&logo=codecov&logoColor=white" alt="coverage"/></a>&nbsp;
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A5%2020-f5f5f5?style=flat&labelColor=339933&logo=nodedotjs&logoColor=white" alt="node"/></a>&nbsp;
  <a href="https://nestjs.com/"><img src="https://img.shields.io/badge/nestjs-10%2B-f5f5f5?style=flat&labelColor=E0234E&logo=nestjs&logoColor=white" alt="nestjs"/></a>&nbsp;
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-f5f5f5?style=flat&labelColor=3DA639&logo=opensourceinitiative&logoColor=white" alt="license"/></a>
</p>

<p align="center">
  <a href="https://horizonrepublic.github.io/nestjs-jetstream/"><b>Documentation</b></a>
  &nbsp;·&nbsp;
  <a href="https://horizonrepublic.github.io/nestjs-jetstream/docs/getting-started/quick-start">Quick Start</a>
  &nbsp;·&nbsp;
  <a href="https://horizonrepublic.github.io/nestjs-jetstream/docs/reference/api">API Reference</a>
</p>

---

## Why this exists

NestJS' [built-in NATS transport](https://docs.nestjs.com/microservices/nats) loses messages on pod restart, doesn't retry on failure, and gives you nothing to debug with. JetStream fixes all three — but wiring it into NestJS by hand is a project on its own.

**This library is the swap.** Same `@EventPattern`, same `@MessagePattern`, same `client.emit()`. Durability, retries, and tracing underneath.

## What you get

- **At-least-once delivery** — every event acked after the handler resolves; bounded retries with exponential backoff.
- **Broadcast** — one message reaches every running pod via per-service durable consumers.
- **Ordered delivery** — sequential per partition key without giving up horizontal scale.
- **RPC** — Core for speed, JetStream for durability — same @MessagePattern either way.
- **DLQ** — typed sink with original headers preserved after retries are exhausted.
- **Scheduled messages, per-message TTL, health checks, graceful shutdown** — all the production levers.
- **OpenTelemetry-compatible** — W3C `traceparent` propagated through every hop.

## Install

```bash
npm i @horizon-republic/nestjs-jetstream
```

## Quick Start

```ts
// app.module.ts
@Module({
  imports: [
    JetstreamModule.forRoot({ servers: ['nats://localhost:4222'] }),
  ],
})
export class AppModule {}
```

```ts
// orders.controller.ts
@Controller()
export class OrdersController {
  @EventPattern('orders.created')
  async onCreated(@Payload() order: Order) {
    await this.billing.charge(order);
  }
}
```

That's it. At-least-once. Retries on throw. Traced end-to-end.

The full configuration surface, every pattern, and the production checklist live in the [documentation](https://horizonrepublic.github.io/nestjs-jetstream/).

## Quality

The transport is covered by an extensive test suite (unit and integration) — see the [Codecov report](https://codecov.io/github/HorizonRepublic/nestjs-jetstream) above. 

Runnable demos for most supported patterns live under [`examples/`](./examples).

---

MIT · © 2026 Horizon Republic · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
