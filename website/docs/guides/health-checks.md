---
sidebar_position: 3
sidebar_label: "Health Checks"
title: "How to expose health checks: NestJS JetStream"
description: "Expose NATS connection status and RTT latency as a Kubernetes readiness/liveness probe with the JetstreamHealthIndicator, with or without @nestjs/terminus."
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

`JetstreamHealthIndicator` reports the NATS connection status and round-trip latency. [`forRoot()`](/docs/reference/module-configuration#forroot) registers the module globally, so the indicator can be injected in any module without importing `JetstreamModule` again or adding it to `providers`.

## What it checks

Each call checks every connection for two things:

1. **Connection status**: is the NATS connection open?
2. **RTT latency**: a round-trip ping to the server through `nc.rtt()`, in milliseconds.

A closed connection, a failed ping, or a ping with no answer within 5 seconds marks that connection unhealthy. The timeout keeps a stalled server from holding the probe open.

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
  degraded?: boolean;      // multiple connections only
  connections?: Record<string, JetstreamConnectionHealth>; // multiple connections only
}
```

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

    if (!status.connected) {
      throw new ServiceUnavailableException({ status: 'error', nats: status });
    }

    return { status: 'ok', nats: status };
  }
}
```

### isHealthy(key?): Terminus-compatible

`isHealthy()` follows the [@nestjs/terminus](https://docs.nestjs.com/recipes/terminus) convention. It returns `{ [key]: { status: 'up', ... } }` on success and **throws** on failure. `key` defaults to `'jetstream'`.

```json
{
  "jetstream": {
    "status": "up",
    "server": "nats://localhost:4222",
    "latency": 2
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

- `connected` means every **critical** connection is alive, and `isHealthy()` throws only when it is false.
- `degraded` means at least one **non-critical** connection is down. It is orthogonal to `connected`, so a dead analytics cluster degrades the report without failing readiness.
- `server` and `latency` describe the default connection.

`isHealthy()` adds `degraded` and `connections` to its details too. With a single connection both fields are absent.

## See also

For push-based visibility instead of a point-in-time check, [lifecycle hooks](/docs/guides/lifecycle-hooks) report every `Connect`, `Disconnect` and `Reconnect` event, which you can stream into your metrics pipeline alongside the indicator.
