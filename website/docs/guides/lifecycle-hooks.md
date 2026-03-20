---
sidebar_position: 6
title: "Lifecycle Hooks"
---

# Lifecycle Hooks

The transport emits lifecycle events at key moments -- connection changes, errors, message routing, shutdown, and dead letters. Register hook callbacks to integrate with your monitoring, alerting, or logging infrastructure.

## Available events

All 9 events are defined in the `TransportEvent` enum:

| Event | Signature | When it fires |
|---|---|---|
| `Connect` | `(server: string) => void` | NATS connection established |
| `Disconnect` | `() => void` | NATS connection lost |
| `Reconnect` | `(server: string) => void` | NATS connection re-established after a disconnect |
| `Error` | `(error: Error, context?: string) => void` | Any transport-level error |
| `RpcTimeout` | `(subject: string, correlationId: string) => void` | An RPC handler exceeds its timeout |
| `MessageRouted` | `(subject: string, kind: 'rpc' \| 'event') => void` | A message is successfully routed to its handler |
| `ShutdownStart` | `() => void` | Graceful shutdown sequence begins |
| `ShutdownComplete` | `() => void` | Graceful shutdown sequence finishes |
| `DeadLetter` | `(info: DeadLetterInfo) => void` | A message exhausts all delivery attempts |

## Registering hooks

Pass a `hooks` object in `forRoot()` or `forRootAsync()`. Only register the events you care about -- unregistered events are silently ignored.

```typescript title="src/app.module.ts"
import { Module } from '@nestjs/common';
import { JetstreamModule, TransportEvent } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
      hooks: {
        [TransportEvent.Connect]: (server) => {
          console.log(`Connected to ${server}`);
        },
        [TransportEvent.Disconnect]: () => {
          console.warn('NATS connection lost');
        },
        [TransportEvent.Error]: (error, context) => {
          console.error(`Transport error [${context}]:`, error);
        },
      },
    }),
  ],
})
export class AppModule {}
```

## Practical examples

### Sentry error tracking

Report transport errors and dead letters to Sentry:

```typescript
import * as Sentry from '@sentry/node';
import { JetstreamModule, TransportEvent } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  hooks: {
    [TransportEvent.Error]: (error, context) => {
      Sentry.captureException(error, {
        tags: { component: 'jetstream', context },
      });
    },
    [TransportEvent.DeadLetter]: (info) => {
      Sentry.captureMessage(`Dead letter: ${info.subject}`, {
        level: 'error',
        extra: {
          stream: info.stream,
          deliveryCount: info.deliveryCount,
          streamSequence: info.streamSequence,
        },
      });
    },
  },
})
```

### Prometheus metrics

Track message throughput, RPC timeouts, and connection state:

```typescript
import { Counter, Gauge } from 'prom-client';
import { JetstreamModule, TransportEvent } from '@horizon-republic/nestjs-jetstream';

const messagesRouted = new Counter({
  name: 'jetstream_messages_routed_total',
  help: 'Total messages routed to handlers',
  labelNames: ['subject', 'kind'],
});

const rpcTimeouts = new Counter({
  name: 'jetstream_rpc_timeouts_total',
  help: 'Total RPC handler timeouts',
  labelNames: ['subject'],
});

const connected = new Gauge({
  name: 'jetstream_connected',
  help: 'Whether the NATS connection is active (1 = up, 0 = down)',
});

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  hooks: {
    [TransportEvent.Connect]: () => connected.set(1),
    [TransportEvent.Disconnect]: () => connected.set(0),
    [TransportEvent.Reconnect]: () => connected.set(1),
    [TransportEvent.MessageRouted]: (subject, kind) => {
      messagesRouted.inc({ subject, kind });
    },
    [TransportEvent.RpcTimeout]: (subject) => {
      rpcTimeouts.inc({ subject });
    },
  },
})
```

### Structured logging

Emit structured JSON logs for all lifecycle events:

```typescript
import { JetstreamModule, TransportEvent } from '@horizon-republic/nestjs-jetstream';

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  hooks: {
    [TransportEvent.Connect]: (server) => log('nats.connect', { server }),
    [TransportEvent.Disconnect]: () => log('nats.disconnect'),
    [TransportEvent.Reconnect]: (server) => log('nats.reconnect', { server }),
    [TransportEvent.Error]: (error, context) =>
      log('nats.error', { message: error.message, context }),
    [TransportEvent.ShutdownStart]: () => log('nats.shutdown.start'),
    [TransportEvent.ShutdownComplete]: () => log('nats.shutdown.complete'),
  },
})
```

## No hook = silence

Events without a registered hook are silently ignored -- no default logging, no warnings, no overhead. The `EventBus` checks if a hook is registered and returns immediately if not. This is intentional: the transport doesn't make assumptions about what you want to observe.

If you want to log everything during development, register hooks for all events. In production, register only the ones that feed your monitoring stack.

## Async hook error handling

Hooks can be synchronous or return a Promise. The `EventBus` handles both cases safely:

- **Synchronous hooks** that throw: the error is caught and logged via the NestJS `Logger`. The transport continues normally.
- **Async hooks** that reject: the rejection is caught via `.catch()` and logged. No `unhandledRejection` event is emitted.

In either case, hook errors **never crash the application** and never affect message processing. Hooks are observability side-channels, not part of the message handling pipeline.

```typescript
hooks: {
  // Safe: if Sentry is down, the error is logged but the app keeps running
  [TransportEvent.Error]: async (error) => {
    await sentry.captureException(error); // rejection is caught by EventBus
  },
}
```

## DeadLetter hook vs onDeadLetter callback

The transport has two dead letter mechanisms that serve different purposes:

| | `hooks[TransportEvent.DeadLetter]` | `onDeadLetter` callback |
|---|---|---|
| **Type** | Synchronous hook (fire-and-forget) | Async callback (awaited) |
| **Fires** | Always, before the callback | Only if configured |
| **Affects message fate?** | No | Yes -- success = `term()`, failure = `nak()` |
| **Use case** | Metrics, logging, alerting | Persisting dead letters to a store |
| **Error behavior** | Caught and logged | Causes message to be `nak`'d for retry |

Use **both** together for complete observability:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  hooks: {
    // Lightweight: increment a counter, always runs
    [TransportEvent.DeadLetter]: (info) => {
      metrics.increment('dead_letter_total', { stream: info.stream });
    },
  },
  // Heavyweight: persist to database, must succeed before term()
  onDeadLetter: async (info) => {
    await dlqRepository.save(info);
  },
})
```

The hook fires first, then the callback. If the callback fails and the message is `nak`'d, the hook will fire again on the next delivery attempt.

## What's next?

- [**Dead Letter Queue**](/docs/guides/dead-letter-queue) -- full guide on dead letter handling and the `onDeadLetter` callback
- [**Health Checks**](/docs/guides/health-checks) -- monitor connection health with RTT latency
- [**Graceful Shutdown**](/docs/guides/graceful-shutdown) -- `ShutdownStart` and `ShutdownComplete` events in context
- [**Module Configuration**](/docs/getting-started/module-configuration) -- `hooks` option in the full options reference
