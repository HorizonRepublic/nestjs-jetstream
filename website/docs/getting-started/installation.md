---
sidebar_position: 1
title: Installation
description: Install the package, set up NATS with Docker, and configure peer dependencies.
schema:
  type: Article
  headline: "Installation"
  description: "Install the package, set up NATS with Docker, and configure peer dependencies."
  datePublished: "2026-03-21"
  dateModified: "2026-04-02"
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

The library requires the following NestJS packages as peer dependencies (they are part of any standard NestJS project):

- `@nestjs/common` ^10.2.0 || ^11.0.0
- `@nestjs/core` ^10.2.0 || ^11.0.0
- `@nestjs/microservices` ^10.2.0 || ^11.0.0
- `reflect-metadata` ^0.2.0
- `rxjs` ^7.8.0

## Runtime requirements

- **Node.js** >= 20.0.0
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

:::tip Docker Compose
For development, you can add NATS to your `docker-compose.yml`:

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
:::

## What's next?

Once you have the package installed and NATS running, head to the [Quick Start](/docs/getting-started/quick-start) to wire up your first handlers.
