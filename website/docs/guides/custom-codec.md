---
sidebar_position: 4
sidebar_label: "Custom Codec"
title: "How to use a custom codec: NestJS JetStream"
description: "Replace the default JSON codec with the built-in MessagePack codec, Protobuf, or any custom binary format for NATS message serialization."
schema:
  type: Article
  headline: "How to use a custom codec with NestJS JetStream"
  description: "Replace JSON with MessagePack, Protobuf, or a custom binary codec for NATS message serialization."
  datePublished: "2026-03-21"
  dateModified: "2026-10-23"
---

# How to use a custom codec

> **Use when:** JSON serialization shows up in profiles, or another language needs a shared wire format.
> **You get:** the `Codec` interface, the built-in MessagePack codec with measured numbers, and where to set it.

A `Codec` serializes message payloads. The default is `JsonCodec`; you can replace it globally, per connection or per client.

## The Codec interface

```typescript
interface Codec {
  /** Serialize application data to binary for NATS transmission. */
  encode(data: unknown): Uint8Array;

  /** Deserialize binary NATS payload back to application data. */
  decode(data: Uint8Array): unknown;
}
```

## Default: JsonCodec

`JsonCodec` uses `JSON.stringify`/`JSON.parse` with the native `TextEncoder`/`TextDecoder`, and applies when no codec is set. An empty payload decodes to `undefined`.

```typescript
import { JsonCodec } from '@horizon-republic/nestjs-jetstream';

const codec = new JsonCodec();
const bytes = codec.encode({ hello: 'world' });   // Uint8Array
const data = codec.decode(bytes);                  // { hello: 'world' }
```

Stay on JSON until serialization shows up in CPU profiles or your p95 payload exceeds about 1-2 KB on the wire. Below that size `JsonCodec` wins on per-call overhead; above it a binary codec pays for itself, and the gap grows with payload size.

## Built-in: MsgpackCodec

`MsgpackCodec` is a [MessagePack](https://msgpack.org/) codec backed by [`msgpackr`](https://www.npmjs.com/package/msgpackr). It produces smaller frames than JSON and decodes structured payloads faster, and the format stays cross-language: Python, Go, Java and Rust all have MessagePack libraries.

### When to use it

Use `MsgpackCodec` when **any** of these apply:

- Average payload size exceeds **~1-2 KB**
- Payloads contain **deep nesting**, **repeated object shapes**, or **long strings**
- `JSON.parse` is visible in flame graphs on the consumer side
- Network bandwidth or NATS stream storage is a bottleneck

Stick with `JsonCodec` when:

- Payloads are small (`< 1 KB`) flat objects: JSON is faster there
- You need a JSON-compatible wire format for tooling (`nats sub`, log aggregators parsing payloads, etc.)
- A non-Node language in your fleet does not have a maintained MessagePack library

### Decode performance (relative to JSON)

Sync `decode` throughput on the library's codec bench. Buckets are the serialized wire size:

| Payload         | Shape         | vs JSON             |
| --------------- | ------------- | ------------------- |
| ~64 B           | flat / nested | JSON wins by 15-34% |
| small (~1 KB)   | flat / nested | JSON wins by ~12%   |
| small (~1 KB)   | string-heavy  | **msgpack +18%**    |
| medium (~10 KB) | flat          | **msgpack +193%**   |
| medium (~10 KB) | nested        | **msgpack +104%**   |
| medium (~10 KB) | string-heavy  | **msgpack +264%**   |
| large (~100 KB) | flat          | **msgpack +478%**   |
| large (~100 KB) | string-heavy  | **msgpack +490%**   |
| ~1 MB           | string-heavy  | **msgpack +325%**   |

### Installation

`msgpackr` is an **optional** peer dependency (`^1.11.0 || ^2.0.0`):

```bash
npm install msgpackr
# or: pnpm add msgpackr
# or: yarn add msgpackr
```

### Usage

Pass your own `Packr` instance, so the library never imports `msgpackr` itself:

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

`msgpackr`'s record extension deduplicates repeated object shapes across messages, which speeds up decoding under sustained load with a stable schema:

```typescript
codec: new MsgpackCodec(new Packr({ structuredClone: true })),
```

:::note
The record extension is a `msgpackr`-specific optimization; use it only when every producer and consumer on the stream also runs `msgpackr` with matching options. Mixed fleets (e.g. a Python consumer) must stick with the plain `new Packr()`.
:::

## Protobuf implementation

A Protocol Buffers codec wraps your generated message classes:

```typescript title="src/codec/protobuf.codec.ts"
import type { Codec } from '@horizon-republic/nestjs-jetstream';

/**
 * Conceptual example, adapt to your Protobuf library
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
A Protobuf codec is tied to one message type. To cover several, write a wrapper that picks the type from an envelope field.
:::

## Where to set the codec

| Level          | Option                                  | Falls back to  |
| -------------- | --------------------------------------- | -------------- |
| Whole module   | `codec` in `forRoot()`/`forRootAsync()` | `JsonCodec`    |
| One connection | `connections.<name>.codec`              | the root codec |
| One client     | `codec` in `forFeature()`               | the root codec |

The `forRoot()` form is in [Usage](#usage). With `forRootAsync()`, return it from the factory:

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  useFactory: () => ({
    servers: ['nats://localhost:4222'],
    codec: new MsgpackCodec(new Packr()),
  }),
})
```

A client that talks to a service on another codec overrides it in `forFeature()`:

```typescript title="src/payments/payments.module.ts"
JetstreamModule.forFeature({
  name: 'legacy-billing',
  codec: new JsonCodec(), // this client only
})
```

## Codec consistency rule

:::danger All communicating services must use the same codec
The codec is the wire format. A consumer on JSON cannot decode what a MessagePack publisher sends, so every service that publishes to or consumes from a stream must use the same codec, across service boundaries too.
:::

## Decode error behavior

When `codec.decode()` throws, redelivery cannot help, so the transport never retries:

| Message                      | Outcome                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workqueue or broadcast event | Becomes a [dead letter](/docs/guides/dead-letter-queue) at once, original bytes intact. With the DLQ off and no `onDeadLetter`, it is terminated. |
| RPC                          | Terminated (`msg.term()`) in JetStream mode; in Core mode the caller gets an error reply.                                                         |
| Ordered event                | Logged and skipped: ordered consumers do not support `term()`.                                                                                    |

Each case logs the subject and the error:

```text
[Jetstream:EventRouter] Decode error for orders__microservice.ev.order.created: Error: ...
[Jetstream:RpcRouter]   Decode error for RPC orders__microservice.cmd.get.order: Error: ...
```

:::tip Migrating codecs
To switch codecs without downtime, first deploy consumers with a wrapper codec that tries the new format and falls back to the old one, then switch the publishers.
:::

## Next steps

- [Record Builder & Deduplication](./record-builder.md): attach headers and dedup IDs to outbound messages
- [Handler Context](./handler-context.md): access decoded payloads and metadata in handlers
- [Module Configuration](/docs/reference/module-configuration): full reference for `forRoot()` and `forFeature()` options
