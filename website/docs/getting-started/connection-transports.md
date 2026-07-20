---
sidebar_position: 3
sidebar_label: "Connection Transports"
title: "NATS TCP, TLS, and WebSocket Connections"
description: "Connect NestJS services to NATS over TCP, TLS, WebSocket, or secure WebSocket, independently of the message pattern or RPC mode."
schema:
  type: Article
  headline: "NATS TCP, TLS, and WebSocket Connections"
  description: "Choose a NATS connection transport by URL while keeping events and RPC configuration independent."
  datePublished: "2026-07-20"
  dateModified: "2026-07-20"
---

# Connection Transports

The library always speaks the **NATS protocol**. The `servers` URL decides how that protocol reaches the NATS server: directly over TCP/TLS or through WebSocket. The transport is selected automatically; ordinary applications do not need a `connectionFactory`.

| Server URL | Physical connection | Selected implementation |
|---|---|---|
| `nats://nats:4222` | NATS over TCP | Node `connect` |
| `tls://nats.example.com:4222` | NATS over TLS | Node `connect` |
| `ws://nats.example.com/nats` | NATS over WebSocket | `wsconnect` |
| `wss://nats.example.com/nats` | NATS over secure WebSocket | `wsconnect` |

```typescript title="TCP connection"
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://nats:4222'],
})
```

```typescript title="Secure WebSocket connection"
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['wss://nats.example.com/nats'],
})
```

Every URL in one `servers` list must belong to the same physical transport family. Multiple TCP/TLS URLs can be used together, and multiple WebSocket URLs can be used together, but WebSocket and TCP/TLS URLs cannot be mixed in one list.

For WebSocket encryption, use `wss://`. Do not pass `connectionOptions.tls` with a WebSocket URL; that option belongs to the Node TCP/TLS transport.

## Connection transport is not an RPC mode

RPC describes the message exchange pattern, not the physical connection. `rpc.mode` is independent of the URL in `servers`:

- **Core RPC** uses native NATS request/reply for the lowest latency.
- **JetStream RPC** persists the command before delivery, then returns the response through a Core NATS inbox.
- **Events, broadcast, and ordered events** use their JetStream streams and consumers.

All message modes work over either connection transport:

| Message mode | TCP/TLS | WebSocket |
|---|---:|---:|
| Durable events | Yes | Yes |
| Broadcast events | Yes | Yes |
| Ordered events | Yes | Yes |
| Core RPC | Yes | Yes |
| JetStream RPC | Yes | Yes |

For example, JetStream RPC over secure WebSocket requires only the URL and RPC mode:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['wss://nats.example.com/nats'],
  rpc: { mode: 'jetstream' },
})
```

Authentication, reconnect settings, handlers, acknowledgements, and recovery behavior are configured the same way for TCP/TLS and WebSocket connections.

## Custom connection factories

`connectionFactory` remains available as an advanced escape hatch for a custom compatible physical transport or tests. It overrides automatic URL-based selection. See [Module Configuration](/docs/reference/module-configuration#connection-transport-selection-and-connectionfactory).

## Next steps

- [Quick Start](/docs/getting-started/quick-start) — register the module and send events or RPC commands.
- [RPC](/docs/patterns/rpc) — choose Core or JetStream request/reply.
- [Module Configuration](/docs/reference/module-configuration) — configure authentication, reconnection, and advanced connection options.
