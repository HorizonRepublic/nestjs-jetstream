---
sidebar_position: 1
title: Installation
---

# Installation

## Install the package

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs groupId="pkg-manager">
  <TabItem value="npm" label="npm">

```bash
npm install @horizon-republic/nestjs-jetstream
```

  </TabItem>
  <TabItem value="pnpm" label="pnpm">

```bash
pnpm add @horizon-republic/nestjs-jetstream
```

  </TabItem>
  <TabItem value="yarn" label="yarn">

```bash
yarn add @horizon-republic/nestjs-jetstream
```

  </TabItem>
</Tabs>

## Peer dependencies

The library requires these packages to be installed in your project. If you already have a NestJS application, most of them are likely present.

| Package | Version | Notes |
|---|---|---|
| `@nestjs/common` | `^10.2.0 \|\| ^11.0.0` | NestJS core framework |
| `@nestjs/core` | `^10.2.0 \|\| ^11.0.0` | NestJS core framework |
| `@nestjs/microservices` | `^10.2.0 \|\| ^11.0.0` | Microservices module (provides `@EventPattern`, `@MessagePattern`, `ClientProxy`) |
| `nats` | `^2.0.0` | Official NATS.js client |
| `reflect-metadata` | `^0.2.0` | Decorator metadata (standard NestJS dependency) |
| `rxjs` | `^7.8.0` | Reactive extensions (standard NestJS dependency) |

:::info NestJS version compatibility
The library supports both **NestJS 10.x** and **NestJS 11.x**. All features work identically on both major versions.
:::

## Runtime requirements

- **Node.js** >= 20.0.0
- **NATS Server** with JetStream enabled

## Run NATS locally

The fastest way to get a JetStream-enabled NATS server running is with Docker:

```bash
docker run -d --name nats -p 4222:4222 nats:latest -js
```

This starts NATS on `localhost:4222` with JetStream enabled (`-js` flag).

To verify it's running:

```bash
docker logs nats | head -5
```

You should see output like:

```
[1] ... [INF] Starting nats-server
[1] ... [INF]   Version:  2.x.x
[1] ... [INF] Starting JetStream
[1] ... [INF] Listening for client connections on 0.0.0.0:4222
[1] ... [INF] Server is ready
```

:::tip Docker Compose
For development, you can add NATS to your `docker-compose.yml`:

```yaml title="docker-compose.yml"
services:
  nats:
    image: nats:latest
    command: -js
    ports:
      - "4222:4222"
      - "8222:8222" # monitoring
```

The monitoring port (`8222`) gives you access to the [NATS monitoring endpoint](https://docs.nats.io/running-a-nats-service/configuration/monitoring) for debugging.
:::

## What's next?

Once you have the package installed and NATS running, head to the [Quick Start](/docs/getting-started/quick-start) to wire up your first handlers.
