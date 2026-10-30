---
sidebar_position: 3
sidebar_label: "Health Checks"
title: "How to expose health checks: NestJS JetStream"
description: "Expose NATS connection status, RTT latency and consumer health as a Kubernetes readiness probe with the JetstreamHealthIndicator, with or without @nestjs/terminus."
schema:
  type: Article
  headline: "How to expose health checks for NATS JetStream"
  description: "Expose NATS connection status and RTT latency as a Kubernetes readiness/liveness probe using JetstreamHealthIndicator."
  datePublished: "2026-03-21"
  dateModified: "2026-10-30"
---

# How to expose health checks

> **Use when:** you are wiring Kubernetes readiness and liveness probes.
> **You get:** `JetstreamHealthIndicator`, the shape it returns, and which probe should watch what.

`JetstreamHealthIndicator` reports the NATS connection status, its round-trip latency, and whether the consumers behind your handlers are actually consuming. [`forRoot()`](/docs/reference/module-configuration#forroot) registers the module globally, so the indicator can be injected in any module without importing `JetstreamModule` again or adding it to `providers`.

## What it checks

Each call checks every connection for three things:

1. **Connection status**: is the NATS connection open?
2. **RTT latency**: a round-trip ping to the server through `nc.rtt()`, in milliseconds.
3. **Consumption**: did the connection finish starting, and is every consumer it runs live?

A closed connection, a failed ping, or a ping with no answer within 5 seconds marks that connection unhealthy. The timeout keeps a stalled server from holding the probe open.

### Consumption

A live connection does not mean messages are flowing. A consumer can be stuck in its self-healing loop while the connection answers every ping: the consumer or its stream was deleted, a stream migration on another pod holds the lock, or an [externally managed](/docs/guides/external-infrastructure) consumer is missing. The indicator reports each consume flow under `consumers`, keyed by kind (`event`, `command`, `broadcast`, `ordered`, `schedule`):

```json
{
  "event": {
    "healthy": false,
    "state": "recovering",
    "consumer": "orders__microservice_ev-consumer",
    "failures": 6,
    "downForMs": 41250,
    "lastError": "Consumer orders__microservice_ev-consumer on orders__microservice_ev-stream is externally managed and currently absent; waiting for it to be restored."
  }
}
```

- `state` is `active` while consuming, `starting` until the flow is live for the first time, and `recovering` once a live flow went down and is restarting.
- A flow turns `healthy: false` only after it has not been live for **30 seconds**. A NATS restart or a consumer that self-healing recreates within that window does not flip readiness, so the probe does not flap.
- `consuming` is `false` when any flow is unhealthy, and also while the connection has not finished starting: still provisioning, waiting for a migration, or a non-critical connection retrying its start in the background.

`consuming` and `consumers` are absent for a connection that does not consume: a `publisherOnly` connection, or an application that never attached the microservice.

## Readiness versus liveness

Wire the indicator to your **readiness** probe, never to liveness.

A liveness probe that touches NATS turns a network blip into a pod restart at exactly the moment the transport is recovering, and since every replica sees the same blip, they restart together. Readiness watches the transport. Liveness watches the process.

## Two APIs

| Method            | Throws on unhealthy? | Use case                                     |
| ----------------- | -------------------- | -------------------------------------------- |
| `check()`         | No                   | Custom health endpoints, metrics, monitoring |
| `isHealthy(key?)` | Yes                  | `@nestjs/terminus`                           |

### check(): plain status object

`check()` returns a `JetstreamHealthStatus` and **never throws**:

```typescript
interface JetstreamHealthStatus {
  connected: boolean;
  server: string | null;   // NATS server URL, or null if disconnected
  latency: number | null;  // RTT in ms, or null if disconnected
  consuming?: boolean;     // absent when nothing consumes
  consumers?: Record<string, JetstreamConsumerHealth>; // default connection's flows
  degraded?: boolean;      // multiple connections only
  connections?: Record<string, JetstreamConnectionHealth>; // multiple connections only
}
```

`connected` describes the connection alone. A custom endpoint that should fail when consumption stalls checks `consuming === false` as well, the way `isHealthy()` does.

A connection that serves handlers stays `connected: false` for good once NATS gives up reconnecting it, even after a client call dials a new connection: the handlers stay bound to the closed one, so only a restart brings them back. See [connection failure behavior](/docs/reference/edge-cases#connection-failure-behavior).

It needs no extra dependency. A standalone endpoint picks its own response shape and status code:

```typescript title="src/health/health.controller.ts"
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { JetstreamHealthIndicator } from '@horizon-republic/nestjs-jetstream';

@Controller('health')
export class HealthController {
  constructor(private readonly jetstream: JetstreamHealthIndicator) {}

  @Get()
  async check() {
    const status = await this.jetstream.check();

    if (!status.connected || status.consuming === false) {
      throw new ServiceUnavailableException({ status: 'error', nats: status });
    }

    return { status: 'ok', nats: status };
  }
}
```

### isHealthy(key?): Terminus-compatible

`isHealthy()` follows the [@nestjs/terminus](https://docs.nestjs.com/recipes/terminus) convention. It returns `{ [key]: { status: 'up', ... } }` on success and **throws** on failure. `key` defaults to `'jetstream'`. The status is `down` when a critical connection is down or `consuming` is `false`.

```json
{
  "jetstream": {
    "status": "up",
    "server": "nats://localhost:4222",
    "latency": 2,
    "consuming": true,
    "consumers": {
      "event": { "healthy": true, "state": "active", "consumer": "orders__microservice_ev-consumer", "failures": 0, "downForMs": null, "lastError": null }
    }
  }
}
```

On failure it throws a plain `Error` (not a Terminus `HealthCheckError`) with `isHealthCheckError: true` and a `causes` property holding the same shape with `"status": "down"`. Terminus v10 and v11 both read that contract, so the details reach the health report. Keep this in mind if you catch the error in your own code.

Plug it into `HealthCheckService.check()`:

```typescript title="src/health/health.controller.ts"
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { JetstreamHealthIndicator } from '@horizon-republic/nestjs-jetstream';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly jetstream: JetstreamHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.jetstream.isHealthy('nats'), // a custom key, next to your other indicators
    ]);
  }
}
```

## Multiple connections

With [connections](/docs/guides/multi-connection) the status gains two fields:

```json
{
  "connected": true,
  "server": "nats://primary:4222",
  "latency": 1,
  "degraded": true,
  "connections": {
    "primary":   { "connected": true,  "critical": true,  "server": "nats://primary:4222", "latency": 1 },
    "analytics": { "connected": false, "critical": false, "server": null, "latency": null }
  }
}
```

- `connected` means every **critical** connection is alive.
- `consuming` means every **critical** connection that consumes has started and keeps its consumers live. `isHealthy()` throws when `connected` or `consuming` is false.
- `degraded` means at least one **non-critical** connection is down or not consuming. It is orthogonal to `connected`, so a dead analytics cluster degrades the report without failing readiness.
- `server`, `latency` and `consumers` describe the default connection. Each entry in `connections` carries its own `consuming` and `consumers`.

`isHealthy()` adds `degraded` and `connections` to its details too. With a single connection both fields are absent.

## See also

For push-based visibility instead of a point-in-time check, [lifecycle hooks](/docs/guides/lifecycle-hooks) report every `Connect`, `Disconnect` and `Reconnect` event, which you can stream into your metrics pipeline alongside the indicator.
