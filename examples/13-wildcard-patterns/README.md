# NATS wildcard patterns

Run from the repository root with NATS available on port 4222 or run it from docker:

```bash
docker compose up -d
npx tsx --tsconfig examples/tsconfig.json examples/13-wildcard-patterns/main.ts
```

```bash
# orders.created matches orders.*
curl http://localhost:3012/rpc

# orders.special uses the exact handler instead of orders.*
curl http://localhost:3012/exact

# audit.eu.orders.created matches audit.> (see application logs)
curl http://localhost:3012/event
```

The RPC responses include the matched pattern and the actual full NATS subject.
The event handler logs both. This example uses Core RPC; set
`rpc: { mode: 'jetstream' }` in `forRoot()` to use durable RPC with the same handlers.

## Matching rules

`@MessagePattern()` and `@EventPattern()` support standard NATS subscription
patterns: `*` matches exactly one dot-separated token; a trailing `>` matches
one or more tokens. For example, `orders.*` matches `orders.created`, while
`orders.>` also matches `orders.eu.created` but does not match `orders`.
Publishers must still send to a concrete subject.

```ts
@MessagePattern('orders.*')
handleOrder(@Payload() data: unknown, @Ctx() context: RpcContext) {
  return { subject: context.getSubject(), data };
}
```

Exact handlers take precedence over wildcard handlers. Overlapping wildcard
handlers (for example `orders.*` and `*.created`) are rejected at startup.
Matching uses the configured subject prefix and applies to Core RPC, JetStream
RPC, and regular, broadcast, and ordered events. Scheduled handlers still require
literal patterns. Invalid patterns such as `order*`, `**`, or `orders.>.created`
are rejected at startup.

Handler metadata KV keys escape `=`, `*`, and `>` as `=3d`, `=2a`, and `=3e`.
Use the exported `metadataKey()` helper to construct discovery keys.
