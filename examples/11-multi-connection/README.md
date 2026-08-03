# Multi-connection

One service talking to two independent NATS clusters through named connections.

What it shows:

- `connections` map with `defaultConnection`, replacing the flat `servers` form
- `@JetstreamConnection('analytics')` binding a whole controller to one cluster
- `forFeature({ connection })` plus `getClientToken(name, connection)` for publishing
- `critical: false`, so a dead secondary cluster does not stop the service
- `connectJetstreamMicroservices()`, the hybrid bootstrap for more than one connection
- hooks receiving the originating connection as a trailing argument

## Run

Two independent clusters are needed. The repository-root compose file provides the primary one on `4222`; this example adds a second on `4223`.

```bash
docker compose up -d                                                     # primary  → 4222
docker compose -f examples/11-multi-connection/docker-compose.yaml up -d # analytics → 4223

npx tsx --tsconfig examples/tsconfig.json examples/11-multi-connection/main.ts
```

Then:

```bash
curl localhost:3010/place-order   # published and handled on the primary cluster
curl localhost:3010/track         # published and handled on the analytics cluster
```

You should see `primary cluster: order …` and `analytics cluster: view /checkout` in the log — each from the cluster its handler is bound to.

## Try the degraded path

```bash
docker stop nestjs_jetstream_nats_analytics
```

The service keeps running and `/place-order` still works: `analytics` is `critical: false`. Restart the container and the consumer reattaches on its own, with the `ConsumerRecovered` hook naming the connection.

Make `analytics` critical (drop `critical: false`) and the same experiment fails startup instead — which is the point of the flag.

## Clean up

```bash
docker compose -f examples/11-multi-connection/docker-compose.yaml down
```
