---
sidebar_position: 1
title: Installation
schema:
  type: Article
  headline: "Installation"
  description: "Install the package, set up NATS with Docker, and configure peer dependencies."
  datePublished: "2026-03-21"
  dateModified: "2026-03-26"
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

## Runtime requirements

- **Node.js** >= 22.0.0
- **NATS Server** >= 2.10 with JetStream enabled

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
