# Core

`@horizon-republic/nestjs-jetstream` — production NestJS transport for NATS JetStream. OSS, npm-published, Release Please releases from conventional commits.

Source map (src/):
- `jetstream.module.ts` — DI wiring root (forRoot/forRootAsync factories); all providers constructed here.
- `jetstream.constants.ts` — naming convention helpers (`internalName`, `streamName`, `consumerName`, `dlqStreamName`, `buildSubject`, `buildBroadcastSubject`), default stream/consumer configs, `toNanos`, RESERVED_HEADERS, `isCoreRpcMode`/`isJetStreamRpcMode` (type predicate).
- `interfaces/` — public types: `StreamKind` (ev/cmd/broadcast/ordered), `MessageKind`, `ManagementMode`, options interfaces, hooks, codec.
- `client/` — `JetstreamClient` (ClientProxy: emit/send, JetStream+Core RPC modes, schedule publish with per-message unique `_sch` subjects), `JetstreamRecordBuilder` (headers/messageId/ttl/scheduleAt).
- `server/strategy.ts` — `listen()` boot order: register handlers → ensure streams → ensure consumers → maps → routers subscribe BEFORE consumption starts (ordering is load-bearing).
- `server/infrastructure/` — `StreamProvider` (ensure/diff/migrate, shared broadcast-stream protections, subject union+collapse), `ConsumerProvider` (ensure vs recover semantics), `StreamMigration` (quiesce→backup→recreate→restore, lag-based drains, interrupted-migration recovery, peer-wait via metadata stamp), `provisioning-*` (#175 summary/budget/errors), `management.ts`, `name-resolver.ts`, `infrastructure-binder.ts`, `subject-utils.ts` (`subjectCovers`).
- `server/routing/` — `EventRouter` (settlement, dead-letter chain, concurrency limiter+backlog with ack-extension, unroutable→DLQ capture), `RpcRouter`, `PatternRegistry` (full-subject → handler map; forward-built subjects do reverse routing).
- `context/rpc.context.ts` — handler ctx: retry()/terminate() settlement signals.
- `utils/` — ack-extension pool, `settleQuietly`, unwrap-result, serialize-error.
- `otel/`, `metrics/`, `health/`, `hooks/` (EventBus — hook errors isolated).

Invariants:
- Settlement calls (ack/nak/term) are publishes — always guarded (`settleQuietly`); never let them kill routing.
- Server never redelivers past max_deliver — nak there strands the message; dead-letter chain is the only second chance.
- broadcast-stream is cluster-shared: never destructively migrated, subjects unioned+collapsed (self-overlap err 10052).
- ADR-51: one active schedule per subject → schedule subjects carry per-message nuid suffix.

Module details: `mem:tech_stack`, `mem:conventions`, `mem:suggested_commands`, `mem:task_completion`.
