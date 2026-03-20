---
sidebar_position: 3
title: "Custom Codec"
---

# Custom Codec

The transport uses a `Codec` to serialize and deserialize message payloads. By default, `JsonCodec` handles everything using the native nats.js JSON implementation. You can replace it globally or per-client with any binary format.

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

Both methods work with `Uint8Array` -- the binary format that NATS uses on the wire.

## Default: JsonCodec

The built-in `JsonCodec` wraps the nats.js `JSONCodec` and is used automatically when no codec is specified:

```typescript
import { JsonCodec } from '@horizon-republic/nestjs-jetstream';

const codec = new JsonCodec();
const bytes = codec.encode({ hello: 'world' });   // Uint8Array
const data = codec.decode(bytes);                  // { hello: 'world' }
```

JSON is a good default for development and most production workloads. Consider a binary codec when you need smaller payloads or faster serialization.

## MsgPack implementation

[MessagePack](https://msgpack.org/) produces smaller payloads than JSON with faster serialization. Here is a complete implementation using `@msgpack/msgpack`:

```typescript title="src/codec/msgpack.codec.ts"
import { encode, decode } from '@msgpack/msgpack';
import type { Codec } from '@horizon-republic/nestjs-jetstream';

export class MsgPackCodec implements Codec {
  encode(data: unknown): Uint8Array {
    return encode(data);
  }

  decode(data: Uint8Array): unknown {
    return decode(data);
  }
}
```

```bash
pnpm add @msgpack/msgpack
```

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
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';
import { MsgPackCodec } from './codec/msgpack.codec';

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
      codec: new MsgPackCodec(),
    }),
  ],
})
export class AppModule {}
```

When using `forRootAsync()`:

```typescript
JetstreamModule.forRootAsync({
  useFactory: () => ({
    name: 'orders',
    servers: ['nats://localhost:4222'],
    codec: new MsgPackCodec(),
  }),
})
```

## Per-client override via forFeature

If a specific client needs a different codec (e.g., it talks to a legacy service that uses JSON while the rest of your system uses MsgPack), override it in `forFeature()`:

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

- **Workqueue and RPC messages**: the message is **terminated** (`msg.term()`) -- it will not be redelivered. Retrying a message that cannot be decoded would cause an infinite failure loop.
- **Ordered events**: the message is **skipped** (logged and dropped) since ordered consumers do not support `term()`.

In both cases, the error is logged with the full subject and error details.

```
[Jetstream:EventRouter] Decode error for orders__microservice.ev.order.created: Error: ...
[Jetstream:RpcRouter]   Decode error for RPC orders__microservice.cmd.get.order: Error: ...
```

:::tip Migrating codecs
To switch codecs without downtime, deploy consumers that can handle both formats first (using a wrapper codec that tries the new format and falls back to the old one), then switch publishers.
:::

## Next steps

- [Record Builder & Deduplication](./record-builder.md) -- attach headers and dedup IDs to outbound messages
- [Handler Context](./handler-context.md) -- access decoded payloads and metadata in handlers
- [Module Configuration](/docs/getting-started/module-configuration) -- full reference for `forRoot()` and `forFeature()` options
