---
sidebar_position: 4
title: "Custom Codec"
schema:
  type: Article
  headline: "Custom Codec"
  description: "Replace the default JSON codec with the built-in MessagePack codec, Protobuf, or any custom binary format."
  datePublished: "2026-03-21"
  dateModified: "2026-04-16"
---

# Custom Codec

The transport uses a `Codec` to serialize and deserialize message payloads. By default, `JsonCodec` handles everything using the native `TextEncoder`/`TextDecoder` with `JSON.stringify`/`JSON.parse`. You can replace it globally or per-client with any binary format.

## The Codec interface

A codec must implement two methods:

```typescript
interface Codec {
  /** Serialize application data to binary for NATS transmission. */
  encode(data: unknown): Uint8Array;

  /** Deserialize binary NATS payload back to application data. */
  decode(data: Uint8Array): unknown;
}
```

Both methods work with `Uint8Array` — the binary format that NATS uses on the wire.

## Default: JsonCodec

The built-in `JsonCodec` uses the native `TextEncoder`/`TextDecoder` with `JSON.stringify`/`JSON.parse` and is used automatically when no codec is specified:

```typescript
import { JsonCodec } from '@horizon-republic/nestjs-jetstream';

const codec = new JsonCodec();
const bytes = codec.encode({ hello: 'world' });   // Uint8Array
const data = codec.decode(bytes);                  // { hello: 'world' }
```

Rule of thumb: stick with JSON until serialization shows up in CPU profiles or your p95 payload exceeds ~1-2 KB on the wire. Below that size, `JsonCodec` wins on constant per-call overhead. Above it, a binary codec like MessagePack starts paying for itself — and the gap widens dramatically as payloads grow.

## Built-in: MsgpackCodec

The library ships a ready-to-use [MessagePack](https://msgpack.org/) codec powered by [`msgpackr`](https://www.npmjs.com/package/msgpackr). MessagePack produces a smaller wire frame than JSON and decodes much faster on structured payloads, while staying cross-language — Python, Go, Java, Rust, and other runtimes all have MessagePack libraries.

### When to use it

`MsgpackCodec` is the right choice when **any** of these apply:

- Average payload size exceeds **~1-2 KB**
- Payloads contain **deep nesting**, **repeated object shapes**, or **long strings**
- `JSON.parse` is visible in flame graphs on the consumer side
- Network bandwidth or NATS stream storage is a bottleneck

Stick with `JsonCodec` when:

- Payloads are mostly small (`< 1 KB`) flat objects — JSON is faster there
- You need a JSON-compatible wire format for tooling (`nats sub`, log aggregators parsing payloads, etc.)
- A non-Node language in your fleet does not have a maintained MessagePack library

### Decode performance (relative to JSON)

Measured on the library's own codec bench, sync `decode` throughput. Payload buckets refer to the serialized wire size produced by the fixture generator:

| Payload         | Shape          | vs JSON  |
|-----------------|----------------|----------|
| tiny (~64 B)    | flat / nested  | JSON wins by 15-34% |
| small (~1 KB)   | flat / nested  | JSON wins by ~12%   |
| small (~1 KB)   | string-heavy   | **msgpack +18%**    |
| medium (~10 KB) | flat           | **msgpack +193%**   |
| medium (~10 KB) | nested         | **msgpack +104%**   |
| medium (~10 KB) | string-heavy   | **msgpack +264%**   |
| large (~100 KB) | flat           | **msgpack +478%**   |
| large (~100 KB) | string-heavy   | **msgpack +490%**   |
| huge (~1 MB)    | string-heavy   | **msgpack +325%**   |

### Installation

`msgpackr` is an **optional** peer dependency — install it only if you opt into this codec:

```bash
npm install msgpackr
# or: pnpm add msgpackr
# or: yarn add msgpackr
```

### Usage

Pass a pre-constructed `Packr` instance so the library stays decoupled from `msgpackr` internals:

```typescript
import { JetstreamModule, MsgpackCodec } from '@horizon-republic/nestjs-jetstream';
import { Packr } from 'msgpackr';

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
      codec: new MsgpackCodec(new Packr()),
    }),
  ],
})
export class AppModule {}
```

### Record extension (Node-to-Node)

`msgpackr` supports a structured-clone record extension that deduplicates repeated object shapes across messages, yielding extra decode speed under sustained load with a stable payload schema:

```typescript
codec: new MsgpackCodec(new Packr({ structuredClone: true })),
```

:::note
The record extension is a `msgpackr`-specific optimization — use it only when every producer and consumer on the stream also runs `msgpackr` with matching options. Mixed fleets (e.g. a Python consumer) must stick with the plain `new Packr()`.
:::

## Protobuf implementation

For strongly-typed schemas and cross-language compatibility, Protocol Buffers are a natural fit. A Protobuf codec wraps your generated message classes:

```typescript title="src/codec/protobuf.codec.ts"
import type { Codec } from '@horizon-republic/nestjs-jetstream';

/**
 * Conceptual example — adapt to your Protobuf library
 * (protobufjs, ts-proto, google-protobuf, etc.)
 */
export class ProtobufCodec implements Codec {
  constructor(
    private readonly messageType: {
      encode(data: unknown): { finish(): Uint8Array };
      decode(data: Uint8Array): unknown;
    },
  ) {}

  encode(data: unknown): Uint8Array {
    return this.messageType.encode(data).finish();
  }

  decode(data: Uint8Array): unknown {
    return this.messageType.decode(data);
  }
}
```

:::note
A Protobuf codec is inherently tied to a specific message type. You would typically create a wrapper that dispatches to the correct Protobuf type based on the subject or an envelope field.
:::

## Global codec via forRoot

Pass a codec instance in the `forRoot()` options to use it for all messages:

```typescript title="src/app.module.ts"
import { Module } from '@nestjs/common';
import { JetstreamModule, MsgpackCodec } from '@horizon-republic/nestjs-jetstream';
import { Packr } from 'msgpackr';

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
      codec: new MsgpackCodec(new Packr()),
    }),
  ],
})
export class AppModule {}
```

When using `forRootAsync()`:

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  useFactory: () => ({
    servers: ['nats://localhost:4222'],
    codec: new MsgpackCodec(new Packr()),
  }),
})
```

## Per-client override via forFeature

If a specific client needs a different codec (e.g., it talks to a legacy service that uses JSON while the rest of your system uses MessagePack), override it in `forFeature()`:

```typescript title="src/payments/payments.module.ts"
import { Module } from '@nestjs/common';
import { JetstreamModule, JsonCodec } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    JetstreamModule.forFeature({
      name: 'legacy-billing',
      codec: new JsonCodec(), // override: use JSON for this client only
    }),
  ],
})
export class PaymentsModule {}
```

When omitted, `forFeature()` inherits the global codec from `forRoot()`.

## Codec consistency rule

:::danger All communicating services must use the same codec
The codec determines the wire format. If the publisher encodes with MsgPack but the consumer expects JSON, deserialization will fail. Ensure every service that publishes to or consumes from a given stream uses the same codec.

This applies across service boundaries: if `orders-service` publishes events that `notifications-service` consumes, both must use the same codec.
:::

## Decode error behavior

When `codec.decode()` throws (e.g., a MsgPack consumer receives a JSON-encoded message), the transport handles it safely:

- **Workqueue and RPC messages**: the message is **terminated** (`msg.term()`) — it will not be redelivered. Retrying a message that cannot be decoded would cause an infinite failure loop.
- **Ordered events**: the message is **skipped** (logged and dropped) since ordered consumers do not support `term()`.

In both cases, the error is logged with the full subject and error details.

```text
[Jetstream:EventRouter] Decode error for orders__microservice.ev.order.created: Error: ...
[Jetstream:RpcRouter]   Decode error for RPC orders__microservice.cmd.get.order: Error: ...
```

:::tip Migrating codecs
To switch codecs without downtime, deploy consumers that can handle both formats first (using a wrapper codec that tries the new format and falls back to the old one), then switch publishers.
:::

## Next steps

- [Record Builder & Deduplication](./record-builder.md) — attach headers and dedup IDs to outbound messages
- [Handler Context](./handler-context.md) — access decoded payloads and metadata in handlers
- [Module Configuration](/docs/getting-started/module-configuration) — full reference for `forRoot()` and `forFeature()` options
