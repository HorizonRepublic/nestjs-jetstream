---
sidebar_position: 1
sidebar_label: "Installation"
title: Installation
description: Install the package, set up NATS with Docker, and configure peer dependencies.
schema:
  type: Article
  headline: "Installation"
  description: "Install the package, set up NATS with Docker, and configure peer dependencies."
  datePublished: "2026-03-21"
  dateModified: "2026-08-03"
---

# Installation

Get the package installed, NATS running locally, and the peer dependencies lined up. If you already have NATS, skip straight to [Quick Start](./quick-start).

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

Required, and already present in any standard NestJS project:

- `@nestjs/common`, `@nestjs/core`, `@nestjs/microservices`: `^10.2.0 || ^11.0.0 || ^12.0.0`
- `reflect-metadata` ^0.2.0
- `rxjs` ^7.8.0

Optional, install only for the feature that needs it:

- `msgpackr` `^1.11.0 || ^2.0.0` for the [MessagePack codec](/docs/guides/custom-codec#built-in-msgpackcodec)
- `prom-client` ^15.0.0 for [Prometheus metrics](/docs/observability/metrics)
- `@opentelemetry/api` ^1.9.0 for [distributed tracing](/docs/observability/tracing)

:::note NestJS 12 prereleases
The caret ranges above skip prereleases, so installing `@nestjs/common@next` needs a package manager override until 12.0.0 has a stable release.
:::

## Runtime requirements

- **Node.js** >= 22.0.0
- **TypeScript** >= 5.7 (required by `@nats-io/*` v3 typed array generics)
- **NATS Server** >= 2.10 with JetStream enabled (>= 2.12 for [message scheduling](/docs/guides/scheduling))

## Run NATS locally

The fastest way to get a JetStream-enabled NATS server running is with Docker:

```bash
docker run -d --name nats -p 4222:4222 nats:2.12 -js
```

This starts NATS on `localhost:4222` with JetStream enabled (`-js` flag).

To verify it's running:

```bash
docker logs nats | head -5
```

<details>
<summary>NATS via Docker Compose for local development</summary>

```yaml title="docker-compose.yml"
services:
  nats:
    image: nats:2.12
    command: -js
    ports:
      - "4222:4222"
      - "8222:8222" # monitoring
```

The monitoring port (`8222`) gives you access to the [NATS monitoring endpoint](https://docs.nats.io/running-a-nats-service/configuration/monitoring) for debugging.

</details>

## What's next?

Once you have the package installed and NATS running, head to the [Quick Start](/docs/getting-started/quick-start) to wire up your first handlers.
