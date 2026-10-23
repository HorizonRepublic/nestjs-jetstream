---
sidebar_position: 4
sidebar_label: "Recurring Schedules (Cron)"
title: "How to run cron and interval jobs: NestJS JetStream (NATS 2.14)"
description: "Cron and interval schedules for NestJS on NATS JetStream message scheduling (NATS 2.14, ADR-51): declared on a handler or created from a client, kept alive across deploys and replicas."
schema:
  type: Article
  headline: "How to run cron and interval jobs with NestJS JetStream"
  description: "Cron and interval schedules on NATS JetStream message scheduling (NATS 2.14, ADR-51)."
  datePublished: "2026-10-23"
  dateModified: "2026-10-23"
---

# How to run cron and interval jobs

> **Use when:** a handler should run on a timetable, or a client should start a
> job that repeats. **You get:** schedules NATS fires on its own, kept alive
> across deploys and replicas.

NATS fires the schedule and the transport delivers each fire, a **tick**, to
your handler like any other event. No scheduler process runs inside your
service.

## Requirements

- **NATS Server >= 2.14** for cron and interval schedules, **>= 2.12** for a
  one-shot `at` from a client. An older server fails the boot, or the call, with
  a `JetstreamCapabilityError`.
- Upgrade every node of a cluster before enabling schedules. While a schedule's
  stream leader runs an older node, the schedule does not fire, and the
  transport cannot see that from the client side.
- Time zones other than `UTC` need time zone data on the server. The official
  `nats` scratch images carry none, while the `nats:*-alpine` images do.

## Declare a schedule on a handler

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';

@Controller()
export class SyncController {
  @EventPattern<string>('sync.tick', {
    schedule: { cron: '0 */10 * * * *', timezone: 'Europe/Kyiv' },
  })
  async tick(): Promise<void> {
    // runs every ten minutes, Kyiv time
  }

  @EventPattern<string>('cache.refresh', { schedule: { everySeconds: 60 } })
  async refresh(): Promise<void> {}
}
```

At boot the transport writes each declared schedule to NATS, after its stream
exists and before any tick is routed. Nothing else is needed in `forRoot()`.

The explicit `<string>` picks the untyped `@EventPattern` overload, see
[troubleshooting](/docs/guides/troubleshooting#unable-to-resolve-signature-of-method-decorator-on-eventpattern).

### Cron expressions

Fields run seconds first: `sec min hour dom month dow`.

| Field            | Values                               |
| ---------------- | ------------------------------------ |
| seconds, minutes | `0-59`                               |
| hours            | `0-23`                               |
| day of month     | `1-31`                               |
| month            | `1-12` or `jan`-`dec`                |
| day of week      | `0-6` (Sunday is `0`) or `sun`-`sat` |

Each field takes `*`, `?`, a value, a range `a-b`, a list `a,b` and a step `*/n`
or `a-b/n`. `n/step` means from `n` to the end of the range. When both day
fields are restricted, a day matching either one fires.

The aliases `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`
and `@hourly` work in place of an expression.

NATS rejects five-field expressions, `L`, `W`, `#` and `7` for Sunday, and so
does the transport, at registration, before anything reaches the server. A
missing seconds field also fails to compile when the expression is a literal.

### Intervals

`everySeconds` is a whole number of seconds, at least `1`. NATS schedules have
one-second resolution: the server accepts `1500ms` and fires every two seconds,
so the transport refuses fractions instead of rounding them.

An interval counts from the moment its schedule was written. For ticks aligned
to the clock, use a cron expression.

### Payload and tick TTL

`data` is the payload of every tick, encoded with the connection codec. Without
it the handler receives `undefined`.

`ttlSeconds` bounds how long an unconsumed tick waits in the stream. It defaults
to the interval, or for a cron to the shortest gap between its next fires, so a
service that was down finds one tick waiting instead of a backlog.

## Schedules from a client

A client creates schedules on another service, or its own, at runtime. The
target handler declares `schedule: true`, which routes ticks to it without
declaring a schedule of its own:

```typescript
@EventPattern<string>('reminder.due', { schedule: true })
async remind(@Payload() reminder: Reminder): Promise<void> {}
```

```typescript
const change = await client.schedule(
  `reminder-${userId}`,
  'reminder.due',
  { userId },
  { cron: '0 0 9 * * mon', timezone: 'Europe/Kyiv' },
);

await client.cancelSchedule(`reminder-${userId}`);

const schedules = await client.listSchedules(); // declared and dynamic
```

- The id is one subject token: no `.`, `*`, `>` or whitespace.
- `schedule()` creates or replaces. It returns `created`, `updated` or
  `unchanged`, and an unchanged schedule is not written again.
- `cancelSchedule()` of an id that does not exist does nothing.
- `{ at: Date }` fires once. It suits delays past the events stream's `max_age`,
  which bounds [`scheduleAt()`](./scheduling).

## Deploy order and permissions

Deploy the service with the `schedule: true` handler before a client creates schedules for it. A schedule created while no replica has the handler stays put, but every tick fired in that window is dropped.

With NATS authorization, the service account needs JetStream API access to its schedule stream: `$JS.API.STREAM.INFO`, `$JS.API.STREAM.MSG.GET` and publish on the schedule subjects. A client calling `cancelSchedule()` or `listSchedules()` needs `$JS.API.STREAM.PURGE`, `$JS.API.STREAM.INFO` and `$JS.API.STREAM.MSG.GET` on the target's schedule stream, and `$JS.API.STREAM.NAMES` to find it. `ttl()`, `scheduleAt()` and `schedule()` read `$JS.API.INFO` once per connection to check the server version.

## Delivery semantics

- **At least once per fire.** A tick goes through the same retry and dead-letter
  path as an event.
- **Missed fires collapse.** If the NATS server was down through more than one
  fire, it fires once when it is back.
- **Ticks carry the schedule.** `ctx.getHeader('Nats-Scheduler')` names the
  schedule that fired, and `Nats-Schedule-Next` holds the next fire time. The
  scheduler name plus `ctx.getSequence()` makes an idempotency key.
- **Long jobs need a lock.** A run that can outlast the interval belongs under a
  lock, with every tick acknowledged, so runs never overlap.

## How schedules stay alive

The transport keeps schedules in a dedicated stream,
`{service}__microservice_sched-stream`, created only when a handler declares
`schedule`.

- `max_age` is `0`. A schedule is a stored message, and NATS stops a schedule
  whose message ages out, with no error.
- Its consumer reads ticks only, never the schedules themselves.
- At boot, each declared schedule is compared with what is stored by a hash of
  its definition. Replicas that boot together write it once, and an unchanged
  interval keeps its rhythm.
- A tick that finds no handler is handed back for five seconds, so a replica that has the handler takes it during a rollout. When every delivery is spent, the schedule is cancelled and a warning logged, but only if it was written before that replica started. A schedule written later belongs to a newer release, and an older replica leaves it alone. So removing a handler removes its schedule.
- Under a custom `schedule.subjectPrefix` the consumer reads registered patterns only, so the ticks of a removed handler never arrive. The boot log names those schedules and the subjects to purge instead.

A changed schedule converges at the next boot of a current replica. If an old
replica restarts mid-rollout, it writes the old definition back until then.

## Configuration

The `schedule` block takes the same options as `events`:

```typescript
JetstreamModule.forRoot({
  name: 'billing',
  servers: ['nats://localhost:4222'],
  schedule: {
    consumer: { ack_wait: toNanos(5, 'minutes') },
    concurrency: 1,
    subjectPrefix: 'billing.cron',
  },
});
```

A `schedule.stream.max_age` other than `0` logs a warning at boot, since it
stops schedules silently. NATS cannot source into a stream that holds schedules,
so an immutable change to this stream fails instead of migrating. With a custom
`subjectPrefix`, callers pass it as
`forFeature({ subjectPrefix: { schedule } })`.

Under `provisioning: { management: ManagementMode.Manual }`, the bound stream
must capture the schedule namespace, `{prefix}_cron.>` or
`{service}__microservice._cron.>`, and the consumer filter must not.

## Errors

| Error                                                                                                                                                                 | When                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `JetstreamScheduleError`, reason `invalid-cron`, `invalid-interval`, `invalid-ttl`, `invalid-timezone`, `invalid-at`, `invalid-id`, `invalid-pattern`, `invalid-data` | Rejected by the transport before anything is sent                      |
| `JetstreamScheduleError`, reason `server-timezone-data`                                                                                                               | The server has no data for the time zone; use an alpine image or `UTC` |
| `JetstreamScheduleError`, reason `server-rejected`                                                                                                                    | The server refused the schedule                                        |
| `JetstreamCapabilityError`                                                                                                                                            | The server is older than the feature needs                             |

## See also

- [Scheduling (Delayed Jobs)](./scheduling): one-shot `scheduleAt()` on events
  and broadcasts
- [Lifecycle hooks](./lifecycle-hooks): `TransportEvent.ScheduleReconciled`
  reports what boot wrote
- [Installation](/docs/getting-started/installation#nats-server-versions): which
  feature needs which NATS version
