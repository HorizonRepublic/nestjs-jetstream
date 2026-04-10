---
sidebar_position: 3
sidebar_label: "Health Checks"
title: "Health Checks — NestJS Terminus Indicator for NATS JetStream"
description: "JetstreamHealthIndicator reports NATS connection status and RTT latency for NestJS Kubernetes readiness/liveness probes, with or without @nestjs/terminus."
schema:
  type: Article
  headline: "Health Checks — NestJS Terminus Indicator for NATS JetStream"
  description: "JetstreamHealthIndicator reports NATS connection status and RTT latency for NestJS Kubernetes readiness/liveness probes, with or without @nestjs/terminus."
  datePublished: "2026-03-21"
  dateModified: "2026-04-11"
---

import Since from '@site/src/components/Since';

# Health Checks

<Since version="2.1.0" />

The library provides a `JetstreamHealthIndicator` that reports the NATS connection status and round-trip latency. It is auto-registered by [`forRoot()`](/docs/getting-started/module-configuration#forroot) and exported from the module — no additional setup required.

## What it checks

Every health check call performs two things:

1. **Connection status** — is the NATS connection open?
2. **RTT latency** — a round-trip ping to the NATS server via `nc.rtt()`, measuring actual network latency in milliseconds.

If the connection is closed or the RTT ping fails, the indicator reports the connection as unhealthy.

## Two APIs

The health indicator exposes two methods for different use cases:

| Method | Throws on unhealthy? | Use case |
|---|---|---|
| `check()` | No | Custom health endpoints, monitoring integrations |
| `isHealthy(key?)` | Yes | @nestjs/terminus integration |

### check() — plain status object

`check()` returns a `JetstreamHealthStatus` object and **never throws**. Use it when you want to inspect the status programmatically without try/catch:

```typescript
interface JetstreamHealthStatus {
  connected: boolean;
  server: string | null;   // NATS server URL, or null if disconnected
  latency: number | null;  // RTT in ms, or null if disconnected
}
```

```typescript title="src/health/health.controller.ts"
import { Controller, Get } from '@nestjs/common';
import { JetstreamHealthIndicator } from '@horizon-republic/nestjs-jetstream';

@Controller('health')
export class HealthController {
  constructor(private readonly jetstream: JetstreamHealthIndicator) {}

  @Get()
  async check() {
    const status = await this.jetstream.check();

    return {
      status: status.connected ? 'ok' : 'error',
      nats: {
        connected: status.connected,
        server: status.server,
        latency: status.latency,
      },
    };
  }
}
```

### isHealthy(key?) — Terminus-compatible

`isHealthy()` follows the @nestjs/terminus convention: returns `{ [key]: { status: 'up', ... } }` on success, **throws** on failure. The `key` parameter defaults to `'jetstream'`.

**Success response:**

```json
{
  "jetstream": {
    "status": "up",
    "server": "nats://localhost:4222",
    "latency": 2
  }
}
```

**Failure:** throws an `Error` with the details attached as a property:

```json
{
  "jetstream": {
    "status": "down",
    "server": null,
    "latency": null
  }
}
```

## With @nestjs/terminus

If your project uses [@nestjs/terminus](https://docs.nestjs.com/recipes/terminus), integration is zero-boilerplate. The `isHealthy()` method is designed to plug directly into `HealthCheckService.check()`:

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
      () => this.jetstream.isHealthy(),
    ]);
  }
}
```

You can customize the key name if you have multiple health indicators:

```typescript
return this.health.check([
  () => this.jetstream.isHealthy('nats'),
  () => this.db.pingCheck('database'),
  () => this.redis.pingCheck('cache'),
]);
```

:::caution Terminus error details
The `isHealthy()` method throws a plain `Error` with structured details attached as a property — not a Terminus `HealthCheckError`. Terminus still picks up the details correctly because it reads the error properties, but be aware of this if you catch the error directly in custom code.
:::

## Without @nestjs/terminus (standalone)

You don't need Terminus at all. Use `check()` for a dependency-free health endpoint:

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
      throw new ServiceUnavailableException({
        status: 'error',
        nats: status,
      });
    }

    return {
      status: 'ok',
      nats: status,
    };
  }
}
```

This gives you full control over the response shape and HTTP status code without any additional dependency.

## Auto-registration

`JetstreamHealthIndicator` is automatically provided and exported by `JetstreamModule`. Since `forRoot()` registers the module globally, the indicator is available for injection in **any** module in the application — no need to import `JetstreamModule` again:

```typescript
import { JetstreamHealthIndicator } from '@horizon-republic/nestjs-jetstream';

@Injectable()
export class MonitoringService {
  constructor(private readonly jetstream: JetstreamHealthIndicator) {}

  async collectMetrics() {
    const status = await this.jetstream.check();
    if (status.latency !== null) {
      metrics.gauge('nats_rtt_ms', status.latency);
    }
  }
}
```

No need to add it to any `providers` array or re-import `JetstreamModule` — it's available globally via `forRoot()`.

## See also

If you want more than a point-in-time check, [lifecycle hooks](/docs/guides/lifecycle-hooks) give you push-based visibility into every `Connect`, `Disconnect`, and `Reconnect` event — useful for streaming connection state into your metrics pipeline alongside the health indicator.
