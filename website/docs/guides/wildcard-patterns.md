---
sidebar_label: "Wildcard Patterns"
title: "Wildcard Patterns: NATS * and > Subjects in NestJS Handlers"
description: "Handle many NATS subjects with one NestJS handler using * and > wildcards in @EventPattern and @MessagePattern, with exact-match precedence and startup validation."
schema:
  type: Article
  headline: "Wildcard Patterns: NATS * and > Subjects in NestJS Handlers"
  description: "Handle many NATS subjects with one NestJS handler using * and > wildcards, with exact-match precedence and startup validation."
  datePublished: "2026-11-02"
  dateModified: "2026-11-02"
---

# Wildcard Patterns

> **Use when:** one handler should serve a family of subjects, such as every `orders.*` event or every subject under `audit.`.
> **You get:** NATS `*` and `>` in `@EventPattern` and `@MessagePattern`, the subject that actually arrived, and startup checks that keep routing unambiguous.

## Matching rules

Handler patterns follow NATS subscription syntax:

| Pattern      | Matches                               | Does not match                |
| ------------ | ------------------------------------- | ----------------------------- |
| `orders.*`   | `orders.created`, `orders.cancelled`  | `orders`, `orders.eu.created` |
| `*.created`  | `orders.created`, `users.created`     | `orders.eu.created`           |
| `orders.>`   | `orders.created`, `orders.eu.created` | `orders`                      |
| `orders.*.>` | `orders.eu.created`, `orders.eu.us.x` | `orders.eu`                   |

`*` matches exactly one token and `>` matches one or more trailing tokens. Matching runs against the full subject under the kind's prefix, so a wildcard never reaches past it: an event `>` covers this service's events only, while a broadcast `promo.*` covers `broadcast.promo.*` from every service, as broadcasts always do.

Publishers always send to a concrete subject: `client.emit('orders.created', data)`, never `client.emit('orders.*', data)`.

## Handling

```typescript title="src/orders/orders.controller.ts"
import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { RpcContext } from '@horizon-republic/nestjs-jetstream';

@Controller()
export class OrdersController {
  @EventPattern('orders.*')
  handleOrderEvent(@Payload() data: OrderEvent, @Ctx() ctx: RpcContext): void {
    // ctx.getSubject() → 'orders__microservice.ev.orders.created'
  }

  // Exact handlers win over wildcards, whatever the declaration order
  @EventPattern('orders.cancelled')
  handleCancelled(@Payload() data: OrderEvent): void {}

  @MessagePattern('reports.>')
  generate(@Payload() query: ReportQuery, @Ctx() ctx: RpcContext): Promise<Report> {
    return this.reports.run(ctx.getSubject(), query);
  }
}
```

`ctx.getSubject()` returns the subject the message arrived on, which is how one handler tells `orders.created` from `orders.paid`.

Wildcards work for every delivery pattern: [workqueue events](/docs/patterns/events), [broadcast](/docs/patterns/broadcast), [ordered events](/docs/patterns/ordered-events) and [RPC](/docs/patterns/rpc) in both Core and JetStream mode. Handlers with a [recurring schedule](/docs/guides/recurring-schedules) need a literal pattern, because the schedule publishes to one subject.

## Precedence and overlaps

An exact handler always takes precedence. With `orders.*` and `orders.cancelled` both registered, `orders.cancelled` goes to the exact handler and every other `orders.<x>` to the wildcard.

Two wildcard handlers of the same kind that can match the same subject would make routing depend on declaration order, so the service refuses to start with `JetstreamConfigError` reason `ambiguous-handler-pattern`:

| Pair                       | Overlap example  |
| -------------------------- | ---------------- |
| `orders.*` and `*.created` | `orders.created` |
| `orders.>` and `orders.*`  | `orders.paid`    |
| `>` and anything           | every subject    |

`orders.*` and `orders.*.>` do not overlap, since one needs exactly two tokens and the other at least three. Handlers of different kinds never conflict: an RPC `orders.*` and an event `orders.*` live under different subjects.

## Validation

The service refuses to start with reason `invalid-handler-pattern` when a pattern:

- has an empty token: `orders..created`, `orders.`, `.orders`;
- contains whitespace: `orders. created`;
- puts `>` anywhere but last: `orders.>.created`.

None of these ever formed a valid NATS subject.

Only a whole token is a wildcard. `order*` or `orders.>x` is a literal subject in NATS, and the transport matches it literally too, with a startup warning, because it is usually a glob written by mistake.

## Wildcards and schedule holders

[Scheduled messages](/docs/guides/scheduling) wait in the stream as holder messages under `_sch.`. A consumer whose filter covers a holder receives it, and on a work-queue stream the ack deletes it, so the scheduled message is never delivered.

The default event and ordered prefixes keep holders outside every handler subject. Under a custom `subjectPrefix` the holders sit at `{prefix}_sch.`, and broadcast holders always at `broadcast._sch.`, so a wildcard such as `>` or `*.*.>` could reach them. The service refuses to start with `invalid-handler-pattern` when a wildcard event, broadcast or ordered handler can match a holder subject. Patterns that stay clear, such as `orders.>` or `*.created`, are fine.

## Consumer filters

Under the default prefix the event and command consumers already filter on `{service}__microservice.ev.>` and `….cmd.>`, so nothing changes there. Where the transport filters per handler, which is broadcast, ordered and every kind with a custom `subjectPrefix`, a wildcard handler contributes its wildcard, and exact subjects it covers are dropped from the list:

```text
handlers: orders.*, orders.created, users.created
filter:   company.orders.orders.*, company.orders.users.created
```

Changing handlers between deploys updates the durable consumer in place, including a switch between one filter and several.

## Observability and metadata

- The `subject` label of [metrics](/docs/observability/metrics) and the `messaging.destination.template` attribute of consume and dead-letter [spans](/docs/observability/tracing) hold the declared pattern (`orders.*`), not the arrived subject, so wildcard handlers do not raise label cardinality.
- [Handler metadata](/docs/patterns/handler-metadata#kv-key-format) keys escape `*` and `>`, because NATS KV keys cannot hold them: `orders.*` is stored as `orders.=2a`. Build keys with `metadataKey()`.

## See also

- [Naming Conventions](/docs/reference/naming-conventions): the subject each kind publishes to
- [Errors](/docs/reference/errors#jetstreamconfigerror): every startup configuration error
- [`examples/13-wildcard-patterns`](https://github.com/HorizonRepublic/nestjs-jetstream/tree/main/examples/13-wildcard-patterns): a runnable service
